set -x
npm install -g @microsoft/rush
rm -rf azure-sdk
git clone --depth 1 https://github.com/Azure/azure-sdk-for-js.git azure-sdk
cd azure-sdk
START=$(pwd)
rush update
cd sdk/core/core-util
# Sync up all TS versions used internally so they're all linked from a known location
LOCAL_TS=$(node -e 'console.log(JSON.parse(fs.readFileSync("node_modules/typescript/package.json", "utf8")).version)')
rush add -p "typescript@$LOCAL_TS" --dev -m
# -nervous laugh-
# Relink installed TSes to built TS
cd $START/common/temp/node_modules/.pnpm/typescript@$LOCAL_TS/node_modules
rm -rf typescript
ln -s $TS ./typescript
cd $START
rush rebuild
