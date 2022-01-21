# TODO: building vs code relies on python 3 as well
# although it might be part of node-gyp's postinstall script and could be skipped safely
apt-get update
apt-get install libsecret-1-dev libx11-dev libxkbfile-dev -y
npm i -g yarn --force
rm -rf vscode
git clone --depth 1 https://github.com/microsoft/vscode.git vscode
START=$(pwd)
cd $TS
rm ~/.config/yarn/link/typescript
yarn link

cd $START/vscode/build
yarn link typescript
cd $START/vscode/extensions
yarn add rimraf
yarn link typescript
cd $START/vscode
yarn link typescript
yarn
yarn compile

