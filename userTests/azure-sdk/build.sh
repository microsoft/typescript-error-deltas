npm install -g @microsoft/rush
rm -rf azure-sdk
git clone --depth 1 https://github.com/Azure/azure-sdk-for-js.git azure-sdk
cd azure-sdk
START=$(pwd)
rush update
cd sdk/core/core-http
# Sync up all TS versions used internally so they're all linked from a known location
rush add -p "typescript@3.5.1" --dev -m
# -nervous laugh-
# Relink installed TSes to built TS
cd $START/common/temp/node_modules/.pnpm/typescript@3.5.1/node_modules
rm -rf typescript
ln -s $TS ./typescript
cd $START
rush rebuild --parallelism 1
