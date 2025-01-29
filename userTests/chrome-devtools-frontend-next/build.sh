#!/usr/bin/env bash

rm -rf depot_tools
git clone --depth 1 https://chromium.googlesource.com/chromium/tools/depot_tools.git depot_tools
PATH=depot_tools:$PATH
rm -rf devtools
mkdir devtools
cd devtools
fetch devtools-frontend
cd devtools-frontend
gn gen out/Default
rm -rf node_modules/typescript
ln -s $TS node_modules/typescript

# We don't want to show the ordering of which tasks ran in Ninja, as that is non-deterministic.
# Instead, only show the errors in the log, from the first occurrence of a FAILED task.
# If the task passes, then there is no log written.
autoninja -C out/Default >error.log || tail -n +$(sed -n '/FAILED/=' error.log) error.log
