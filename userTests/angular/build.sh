npm i -g yarn --force
rm -rf angular
git clone --depth 1 https://github.com/angular/angular rxjs
START=$(pwd)
cd $TS
rm ~/.config/yarn/link/typescript
yarn link

cd $START/angular
yarn link typescript
yarn install --ignore-scripts

yarn tsc -p ./packages/tsconfig.json
