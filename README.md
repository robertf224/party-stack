# party-stack

Tools for building real-time applications on top of structured ontologies.

## Contributing

### Getting started

Make sure you have Homebrew installed:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

Next make sure node is installed:

```bash
brew install nvm
nvm install 24.11.1
nvm use 24.11.1
```

Next install pnpm and turbo:

```bash
npm install -g pnpm
npm install -g turbo
```

And finally test that everything works:

```bash
pnpm install
turbo build
```

### Development

Always run `pnpm install` to install packages when starting development.

Run `turbo build` to build the repo, and `turbo watch build dev` to develop against the repo. See the [Turborepo](https://turbo.build/repo/docs/crafting-your-repository/running-tasks#using-filters) docs for syntax for filtering what projects are targeted.
