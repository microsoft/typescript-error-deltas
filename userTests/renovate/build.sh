#!/usr/bin/env bash

npm i -g yarn
rm -rf renovate
git clone --depth 1 https://github.com/renovatebot/renovate.git renovate
START=$(pwd)
cd $TS
rm ~/.config/yarn/link/typescript
yarn link
cd $START/renovate
yarn link typescript
yarn type-check
