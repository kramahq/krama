# Krama

An open-source, A2A-native factory that turns packaged, versioned agent teams into reviewed deliverables.

> **Status:** early development. Not yet usable. Follow progress at https://github.com/kramahq.

Planned entry point: `npx kramahq` (Windows, Linux and macOS).

Licensed under [Apache-2.0](LICENSE).

## Development

Requires Node 22+ and pnpm.

```
pnpm install
pnpm build && pnpm test && pnpm lint
```

`pnpm lint` also enforces the package dependency rule (`.dependency-cruiser.cjs`). Commits use Conventional Commits and a DCO sign-off (`git commit -s`). See the [contributing guide](https://github.com/kramahq/.github/blob/main/CONTRIBUTING.md).
