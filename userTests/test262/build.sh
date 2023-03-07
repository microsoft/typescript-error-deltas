rm -rf test262
git clone --depth 1 https://github.com/tc39/test262.git test262
START=$(pwd)
cd $TS
npm link
cd $START/test262
npm i
npm link typescript
cp $START/tsconfig .
npx tsc
