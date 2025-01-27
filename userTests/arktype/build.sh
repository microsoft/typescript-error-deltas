npm i -g pnpm
rm -rf arktype
git clone --depth 1 https://github.com/arktypeio/arktype.git arktype

START=$(pwd)
cd $TS
pnpm link
cd $START/arktype

pnpm link typescript
pnpm i
pnpm build
