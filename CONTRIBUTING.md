# Contributing to Reins

Thanks for contributing to Reins. This guide covers setup, conventions, and review expectations for all seven repositories.

## Development Setup

1. Install Bun: https://bun.sh
2. Clone all Reins repositories into the same parent directory.
3. In `reins-core`, install and verify:

```bash
bun install
bun run typecheck
bun test
```

4. Link local core package for cross-repo development:

```bash
# in reins-core
bun link

# in another repo (example: reins-tui)
bun link @reins/core
```

## Code Conventions

- TypeScript strict mode is required.
- Use kebab-case for module filenames.
- Use PascalCase for component filenames.
- Keep platform repos as thin shells around shared `@reins/core` logic.
- Prefer small, focused changes.

## Commit Messages

Use conventional commit format:

```text
type(scope): description
```

Examples:
- `feat(core): add provider registry interface`
- `fix(tui): handle empty streaming chunks`
- `docs(core): clarify local linking workflow`

## Pull Request Process

1. Keep each PR scoped to one logical change.
2. Include context for why the change is needed.
3. List verification steps and results.
4. Link related issues or planning items.
5. Wait for CI checks to pass before requesting final review.

## Testing Guidelines

- Run typecheck before opening a PR:

```bash
bun run typecheck
```

- Run tests in the repo you changed:

```bash
bun test
```

- If changes affect `@reins/core`, run downstream checks by linking local core and validating at least one consumer repo.
