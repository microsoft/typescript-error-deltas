#!/usr/bin/env bash

npm i -g yarn
rm -rf prettier
git clone --depth 1 https://github.com/prettier/prettier.git prettier
START=$(pwd)
cd $TS
rm ~/.config/yarn/link/typescript
yarn link
cd $START/prettier
yarn link typescript
yarn
yarn lint:typecheck
