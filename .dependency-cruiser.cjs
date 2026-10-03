// Encodes the dependency rule from the architecture (monorepo layout, section 3).
const pkg = (names) => `^packages/(${names.join('|')})/`;
const adapters = [
  'store',
  'artifacts-fs',
  'agents',
  'pack',
  'skills',
  'work-items',
  'scheduler',
  'builder',
];
const deepAdapters = ['orchestrator-mcp', 'memory', 'testing'];
const forbid = (name, from, toList, comment) => ({
  name,
  comment,
  severity: 'error',
  from: { path: from },
  to: { path: toList, pathNot: from },
});

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    forbid(
      'contract-imports-nothing-internal',
      pkg(['contract']),
      '^(packages|apps)/',
      'contract imports nothing internal',
    ),
    forbid(
      'engine-imports-contract-only',
      pkg(['engine']),
      '^(packages/(?!contract/|engine/)|apps/)',
      'engine imports contract only',
    ),
    forbid(
      'adapters-isolated',
      pkg(adapters),
      '^(packages/(?!contract/|engine/)|apps/)',
      'adapters import contract and engine only, never each other',
    ),
    forbid(
      'deep-adapters-isolated',
      pkg(deepAdapters),
      '^(packages/(?!contract/|engine/)|apps/)',
      'orchestrator-mcp, memory and testing import contract and engine only',
    ),
    forbid(
      'sdk-imports-contract-only',
      pkg(['sdk']),
      '^(packages/(?!contract/|sdk/)|apps/)',
      'sdk imports contract only',
    ),
    forbid(
      'ui-cli-mock-use-sdk-and-contract',
      '^apps/(ui|cli|mock)/',
      '^(packages/(?!contract/|sdk/)|apps/(?!ui/|cli/|mock/))',
      'ui, cli and mock import sdk and contract only',
    ),
    {
      name: 'no-cross-app-imports',
      severity: 'error',
      from: { path: '^apps/([^/]+)/' },
      to: { path: '^apps/([^/]+)/', pathNot: '^apps/$1/' },
      comment: 'apps never import each other',
    },
    { name: 'no-circular', severity: 'error', from: {}, to: { circular: true } },
  ],
  options: {
    tsConfig: { fileName: 'tsconfig.base.json' },
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)dist/' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'types', 'default'],
    },
  },
};
