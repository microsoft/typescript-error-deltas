#!/usr/bin/env bash

rm -rf rxjs
git clone --depth 1 https://github.com/ReactiveX/rxjs rxjs
START=$(pwd)
cd $TS
npm link
cd $START/rxjs
npm install
npm link typescript
npm run compile
