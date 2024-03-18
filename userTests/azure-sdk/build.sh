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

# Limit the build to just those packages that are "client" libraries consumed by downstream users.
# The monorepo contains loads of other packages which make the build too slow for the tester.
RUSH_JSON=$(mktemp)
npx json5 rush.json > $RUSH_JSON
node -e '
for (const x of JSON.parse(fs.readFileSync(process.argv[1], "utf8")).projects) {
    if (x.packageName.startsWith("@azure/") && x.versionPolicyName === "client") {
        console.log("--to", x.packageName);
    }
}' $RUSH_JSON | xargs -x rush rebuild
rm $RUSH_JSON
