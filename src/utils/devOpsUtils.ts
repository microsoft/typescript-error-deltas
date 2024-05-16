import ado = require("azure-devops-node-api");
import { Params, Summary } from "../main";

interface ArtifactContent {
    items: [{
        path: string;
        blob: {
            id: string;
        };
    }];
};

export async function getReplayScriptDownloadUrl(summary: Summary, params: Params) {
    const cli = new ado.WebApi(`${params.teamFoundationCollectionUri}defaultcollection`, ado.getHandlerFromToken("")); // Empty token, anon auth
    const build = await cli.getBuildApi();
    const artifact = await build.getArtifact(params.teamProject, params.buildId, summary.resultDirName);

    if (artifact.resource?.url) {
        const repoResultUrl = new URL(artifact.resource.url);
        repoResultUrl.search = `artifactName=${summary.resultDirName}&fileId=${artifact.resource.data}&fileName=${summary.resultDirName}`;

        const artifactContent = await (await fetch(repoResultUrl)).json() as ArtifactContent;

        const item = artifactContent.items.find(x => x.path.endsWith(summary.replayScriptName));

        const replayScriptUrl = new URL(artifact.resource.url);
        replayScriptUrl.search = `artifactName=${summary.resultDirName}&fileId=${item!.blob.id}&fileName=${summary.replayScriptName}`;

        return replayScriptUrl;
    }
}