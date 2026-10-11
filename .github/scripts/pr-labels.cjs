'use strict';

const YAML = require('yaml');
const { isDeepStrictEqual } = require('node:util');

const TOOL_PATH = 'data/tools.yml';
const SET_FIELDS = new Set(['categories', 'tags', 'interfaces', 'sources']);
const AREA_LABELS = {
  catalog: { color: '0e8a16', description: 'Changes to catalog metadata' },
  documentation: { color: '0075ca', description: 'Improvements or additions to documentation' },
  tooling: { color: 'fbca04', description: 'Changes to scripts, tests, or package configuration' },
  'github-actions': { color: '1d76db', description: 'Changes to GitHub Actions and their supporting scripts' }
};

function parseArray(text, label) {
  const document = YAML.parseDocument(text, { uniqueKeys: true });
  if (document.errors.length || document.warnings.length) {
    throw new Error(`Invalid ${label} YAML: ${[...document.errors, ...document.warnings].map(error => error.message).join('; ')}`);
  }
  // Aliases and custom tags have no role in catalog data. Never execute proposed code.
  const value = document.toJS({ maxAliasCount: 0 });
  if (!Array.isArray(value)) throw new Error(`${label} must be a YAML array`);
  return value;
}

function toolMap(text) {
  const map = new Map();
  for (const tool of parseArray(text, 'tools')) {
    if (!tool || typeof tool !== 'object' || typeof tool.slug !== 'string' || !tool.slug ||
        !Array.isArray(tool.categories) || !tool.categories.length ||
        tool.categories.some(category => typeof category !== 'string' || !category)) {
      throw new Error('Each tool must have a slug and a nonempty array of category strings');
    }
    if (map.has(tool.slug)) throw new Error(`Duplicate tool slug: ${tool.slug}`);
    if (tool.primary_category !== undefined &&
        (typeof tool.primary_category !== 'string' || !tool.categories.includes(tool.primary_category))) {
      throw new Error(`Invalid primary category for ${tool.slug}`);
    }
    map.set(tool.slug, tool);
  }
  return map;
}

function comparable(tool) {
  if (!tool) return tool;
  return Object.fromEntries(Object.entries(tool).map(([field, value]) => [field,
    SET_FIELDS.has(field) && Array.isArray(value) ? [...new Set(value)].sort() : value
  ]));
}

function pathsOf(file) {
  return [file.filename, file.previous_filename].filter(Boolean);
}

function classify({ files, before, after, taxonomy }) {
  const definitions = { ...AREA_LABELS };
  for (const category of parseArray(taxonomy, 'trusted categories')) {
    if (!category || typeof category.slug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(category.slug) ||
        typeof category.name !== 'string') throw new Error('Invalid trusted category');
    definitions[`category:${category.slug}`] = {
      color: '5319e7', description: `Primary category of changed tools: ${category.name}`.slice(0, 100)
    };
  }
  const wanted = new Set();
  const warnings = new Set();
  const paths = files.flatMap(pathsOf);
  for (const path of paths) {
    if (path.startsWith('data/')) wanted.add('catalog');
    if (/\.md$/i.test(path) || path.startsWith('docs/') || path.startsWith('assets/')) wanted.add('documentation');
    if (path.startsWith('scripts/') || path.startsWith('tests/') ||
        ['package.json', 'package-lock.json', 'tsconfig.json'].includes(path)) wanted.add('tooling');
    if (path.startsWith('.github/workflows/') || path.startsWith('.github/scripts/')) wanted.add('github-actions');
  }
  if (paths.includes(TOOL_PATH)) {
    const oldTools = toolMap(before);
    const newTools = toolMap(after);
    for (const slug of new Set([...oldTools.keys(), ...newTools.keys()])) {
      const oldTool = oldTools.get(slug);
      const newTool = newTools.get(slug);
      if (isDeepStrictEqual(comparable(oldTool), comparable(newTool))) continue;
      for (const tool of [oldTool, newTool].filter(Boolean)) {
        const primary = tool.primary_category ?? (tool.categories.length === 1 ? tool.categories[0] : undefined);
        if (!primary) {
          warnings.add(`Tool ${slug} has multiple categories without a primary category; no category inferred`);
        } else if (!definitions[`category:${primary}`]) {
          warnings.add(`Category ${primary} for ${slug} is absent from trusted taxonomy; label skipped until merged`);
        } else {
          wanted.add(`category:${primary}`);
        }
      }
    }
  }
  return { wanted: [...wanted].sort(), definitions, warnings: [...warnings] };
}

async function readTools({ github, owner, repo, ref, allowMissing }) {
  try {
    const { data } = await github.rest.repos.getContent({
      owner, repo, path: TOOL_PATH, ref, headers: { accept: 'application/vnd.github.raw+json' }
    });
    if (typeof data !== 'string') throw new Error(`Expected raw tools YAML from ${owner}/${repo}@${ref}`);
    return data;
  } catch (error) {
    if (allowMissing && error.status === 404) return '[]';
    throw error;
  }
}

async function reconcile({ github, context, core, pull_number, taxonomy }) {
  const { owner, repo } = context.repo;
  const { data: pr } = await github.rest.pulls.get({ owner, repo, pull_number });
  if (pr.state !== 'open') return;
  const files = await github.paginate(github.rest.pulls.listFiles, { owner, repo, pull_number, per_page: 100 });
  if (files.length !== pr.changed_files) throw new Error('Incomplete changed-file list; refusing to reconcile labels');
  let before = '[]';
  let after = '[]';
  if (files.some(file => pathsOf(file).includes(TOOL_PATH))) {
    if (!pr.head.repo) throw new Error('PR head repository is unavailable');
    const { data: comparison } = await github.rest.repos.compareCommitsWithBasehead({
      owner, repo, basehead: `${pr.base.sha}...${pr.head.repo.owner.login}:${pr.head.sha}`, per_page: 1
    });
    const beforeMissing = files.some(file => file.filename === TOOL_PATH &&
      (file.status === 'added' || (file.status === 'renamed' && file.previous_filename !== TOOL_PATH)));
    const afterMissing = files.some(file => (file.filename === TOOL_PATH && file.status === 'removed') ||
      (file.previous_filename === TOOL_PATH && file.status === 'renamed'));
    [before, after] = await Promise.all([
      readTools({ github, owner, repo, ref: comparison.merge_base_commit.sha, allowMissing: beforeMissing }),
      readTools({ github, owner: pr.head.repo.owner.login, repo: pr.head.repo.name, ref: pr.head.sha, allowMissing: afterMissing })
    ]);
  }
  // All parsing and classification completes before any write, including label creation.
  const { wanted, definitions, warnings } = classify({ files, before, after, taxonomy });
  for (const warning of warnings) core.warning(warning);
  const current = (await github.paginate(github.rest.issues.listLabelsOnIssue, {
    owner, repo, issue_number: pull_number, per_page: 100
  })).map(label => label.name);
  const existing = (await github.paginate(github.rest.issues.listLabelsForRepo, {
    owner, repo, per_page: 100
  })).map(label => label.name);
  const { data: latest } = await github.rest.pulls.get({ owner, repo, pull_number });
  if (latest.state !== 'open' || latest.head.sha !== pr.head.sha || latest.base.sha !== pr.base.sha || latest.base.ref !== pr.base.ref) {
    core.warning('PR changed during classification; labels left untouched for the next run');
    return;
  }
  for (const name of wanted.filter(label => !existing.includes(label))) {
    try {
      await github.rest.issues.createLabel({ owner, repo, name, ...definitions[name] });
    } catch (error) {
      // Another PR may have created the same repository label concurrently.
      if (error.status !== 422) throw error;
      const labels = await github.paginate(github.rest.issues.listLabelsForRepo, { owner, repo, per_page: 100 });
      if (!labels.some(label => label.name === name)) throw error;
    }
  }
  const add = wanted.filter(name => !current.includes(name));
  const remove = current.filter(name => (Object.hasOwn(AREA_LABELS, name) || name.startsWith('category:')) && !wanted.includes(name));
  if (add.length) await github.rest.issues.addLabels({ owner, repo, issue_number: pull_number, labels: add });
  for (const name of remove) await github.rest.issues.removeLabel({ owner, repo, issue_number: pull_number, name });
  core.info(JSON.stringify({ wanted, add, remove }));
}

module.exports = { classify, reconcile };
