# typescript-error-deltas

Download and compile popular open source repos in order to compare new versions of the Typescript compiler with the current version.
For example, this project will clone the prettier repo and compile it with the current version of Typescript.
Then it will compile it with a version of Typescript from a pull request.
Afterward it will compile new errors that are issued only with the new version and post them as a comment on the pull request.

There is no comparison of types, errors, symbols or language service output.

## Contributing

### User Tests

There are three kinds of user tests, all of which aim to use popular packages with different versions of Typescript:

1. Example projects, which specify a popular package in package.json and then provide an example use of it.
2. Clones of a repo of a popular package, built with `tsc`.
3. Clones of a repo of a popular package, built with a custom `bash` script.

#### Example projects

Use `userTests/axios` as an example:

- Create a package.json with `axios` as a dependency.
- Create an example program that uses `axios`. In our case, just:
  - index.ts
  - tsconfig.json

The example projects could be as large as a complete app as long as it compiles with a single invocation of `tsc`.
However, the current projects almost all consist of a single import, like `import x = require('x')`.
This could obviously be improved.

#### Clone repos (simple build)

Use `userTests/axios-src` as an example:

Create `test.json` like the following:

``` json
{
    "cloneUrl": "https://github.com/axios/axios.git",
    "types": ["node"]
}
```

The `types` field is optional; it installs `@types/` packages for each entry in its array before running `tsc`.
This is mostly useful if the package isn't written in Typescript and doesn't include types in its own devDependencies.

Like the example projects, the cloned repos must be buildable with a single invocation of `tsc`.

#### Clone repos (script build)

Use `userTests/azure-sdk` as an example; create a script `build.sh` that:

- Clones a repo.
- Installs its dependencies.
- Alters its Typescript dependency to use a custom Typescript version.
- Builds the repo.

The details vary considerably from project to project.
This kind of test allows you to build arbitrary projects.

### Legal

This project welcomes contributions and suggestions.  Most contributions require you to agree to a
Contributor License Agreement (CLA) declaring that you have the right to, and actually do, grant us
the rights to use your contribution. For details, visit https://cla.opensource.microsoft.com.

When you submit a pull request, a CLA bot will automatically determine whether you need to provide
a CLA and decorate the PR appropriately (e.g., status check, comment). Simply follow the instructions
provided by the bot. You will only need to do this once across all repos using our CLA.

This project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/).
For more information see the [Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or
contact [opencode@microsoft.com](mailto:opencode@microsoft.com) with any additional questions or comments.

## Trademarks

This project may contain trademarks or logos for projects, products, or services. Authorized use of Microsoft
trademarks or logos is subject to and must follow
[Microsoft's Trademark & Brand Guidelines](https://www.microsoft.com/en-us/legal/intellectualproperty/trademarks/usage/general).
Use of Microsoft trademarks or logos in modified versions of this project must not cause confusion or imply Microsoft sponsorship.
Any use of third-party trademarks or logos are subject to those third-party's policies.
