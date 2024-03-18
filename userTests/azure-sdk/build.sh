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

# Running everything takes a long time; just build the top 20 client packages by downloads.
rush rebuild \
    --to @azure/identity \
    --to @azure/storage-blob \
    --to @azure/keyvault-keys \
    --to @azure/opentelemetry-instrumentation-azure-sdk \
    --to @azure/cosmos \
    --to @azure/keyvault-secrets \
    --to @azure/service-bus \
    --to @azure/openai \
    --to @azure/app-configuration \
    --to @azure/storage-queue \
    --to @azure/storage-file-share \
    --to @azure/event-hubs \
    --to @azure/communication-common \
    --to @azure/data-tables \
    --to @azure/storage-file-datalake \
    --to @azure/search-documents \
    --to @azure/web-pubsub-client \
    --to @azure/maps-common \
    --to @azure/ai-form-recognizer \
    --to @azure/communication-email
