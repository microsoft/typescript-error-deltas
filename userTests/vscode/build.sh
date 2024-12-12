rm -rf vscode
git clone --depth 1 https://github.com/microsoft/vscode.git vscode
START=$(pwd)
cd $TS
npm link

cd $START/vscode/build
npm link typescript
cd $START/vscode/extensions
npm add rimraf
npm link typescript
cd $START/vscode
npm link typescript
npm install
npm run compile
