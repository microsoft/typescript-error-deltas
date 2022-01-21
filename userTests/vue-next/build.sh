npm install -g yarn lerna --force
rm -rf vue-next
git clone --depth 1 https://github.com/vuejs/core

START=$(pwd)
cd $TS
pnpm link --global # TODO: This doesn't work, or else I need to rebuild
cd $START/core
pnpm link typescript
pnpm install
npm run build --production -- --types
