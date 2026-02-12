import * as cp from "child_process";
import * as rpc from "vscode-jsonrpc/node";
import * as protocol from "vscode-languageserver-protocol";

export interface ServerOptions {
    args?: string[];
    execArgv?: string[];
    env?: NodeJS.ProcessEnv;
}

export interface LanguageServer {
    sendRequest: <K extends keyof RequestToParams>(method: K, params: RequestToParams[K]) => Promise<MessageResponseType[K]>;
    sendRequestUntyped: (method: string, params: object) => Promise<unknown>;
    sendNotification: <K extends keyof NotificationToParams>(method: K, params: NotificationToParams[K]) => Promise<void>;

    handleRequest: <K extends keyof RequestToParams>(method: K, handler: (params: RequestToParams[K]) => Promise<MessageResponseType[K]>) => void;
    handleAnyRequest: (handler: (...args: any[]) => Promise<any>) => void;
    handleNotification: <K extends keyof NotificationToParams>(method: K, handler: (params: NotificationToParams[K]) => void) => void;
    handleAnyNotification: (handler: (...args: any[]) => Promise<any>) => void;

    kill: () => Promise<void>;

    onError: rpc.Event<[Error, rpc.Message | undefined, number | undefined]>;
    onClose: rpc.Event<void>;
}

export function startServer(serverPath: string, options: ServerOptions = {}, otherOptions?: { traceOutput?: boolean; }): LanguageServer {
    const serverProc = cp.spawn(serverPath, options.args ?? [], {
        env: options.env,
        // execArgv: options.execArgv, // options.execArgv ?? process.execArgv?.map(arg => bumpDebugPort(arg)),
        stdio: [
            "pipe", // stdin
            "pipe", // stdout
            otherOptions?.traceOutput ? "inherit" : "ignore" // stderr
        ],
    });

    const connection = rpc.createMessageConnection(
        new rpc.StreamMessageReader(serverProc.stdout),
        new rpc.StreamMessageWriter(serverProc.stdin!)
    );

    connection.listen();

    return {
        sendRequest,
        sendRequestUntyped,
        sendNotification,
        handleRequest,
        handleAnyRequest,
        handleNotification,
        handleAnyNotification,
        kill,
        onError: connection.onError,
        onClose: connection.onClose,
    };

    function sendRequest<K extends keyof RequestToParams>(method: K, params: RequestToParams[K]): Promise<MessageResponseType[K]> {
        return connection.sendRequest(method, params);
    }

    function sendRequestUntyped(method: string, params: object): Promise<unknown> {
        return connection.sendRequest(method, params);
    }

    function sendNotification<K extends keyof NotificationToParams>(method: K, params: NotificationToParams[K]): Promise<void> {
        return connection.sendNotification(method, params);
    }

    function handleRequest<K extends keyof RequestToParams>(method: K, handler: (params: RequestToParams[K]) => Promise<MessageResponseType[K]>): rpc.Disposable {
        return connection.onRequest(method, handler);
    }

    function handleAnyRequest(handler: (...args: any[]) => Promise<any>): rpc.Disposable {
        return connection.onRequest(handler);
    }

    function handleNotification<K extends keyof NotificationToParams>(method: K, handler: (params: NotificationToParams[K]) => void): rpc.Disposable {
        return connection.onNotification(method, handler);
    }

    function handleAnyNotification(handler: (...args: any[]) => Promise<any>): rpc.Disposable {
        return connection.onNotification(handler);
    }

    function kill(): Promise<void> {
        return new Promise((resolve, reject) => {
            serverProc.once("close", () => {
                resolve();
            });
            // If the server has already exited, there won't be a close event
            if (serverProc.exitCode !== null || serverProc.signalCode !== null) {
                resolve();
            }
            if (!serverProc.kill("SIGKILL")) {
                reject(new Error("Failed to send kill signal to server"));
        }
        });
    }
}

export interface RequestToParams {
    [protocol.ShutdownRequest.method]: undefined;
    [protocol.RegistrationRequest.method]: protocol.RegistrationParams;
    [protocol.UnregistrationRequest.method]: protocol.UnregistrationParams;
    [protocol.InitializeRequest.method]: protocol.InitializeParams;
    [protocol.ConfigurationRequest.method]: protocol.DidChangeConfigurationParams;
    [protocol.ShowMessageRequest.method]: protocol.ShowMessageParams;
    [protocol.CompletionRequest.method]: protocol.CompletionParams;
    [protocol.CompletionResolveRequest.method]: protocol.CompletionItem;
    [protocol.HoverRequest.method]: protocol.HoverParams;
    [protocol.SignatureHelpRequest.method]: protocol.SignatureHelpParams;
    [protocol.DefinitionRequest.method]: protocol.DefinitionParams;
    [protocol.ReferencesRequest.method]: protocol.ReferenceParams;
    [protocol.DocumentDiagnosticRequest.method]: protocol.DocumentDiagnosticParams;
    [protocol.DocumentHighlightRequest.method]: protocol.DocumentHighlightParams;
    [protocol.DocumentSymbolRequest.method]: protocol.DocumentSymbolParams;
    [protocol.CodeActionRequest.method]: protocol.CodeActionParams;
    [protocol.CodeActionResolveRequest.method]: protocol.CodeAction;
    [protocol.WorkspaceSymbolRequest.method]: protocol.WorkspaceSymbolParams;
    [protocol.WorkspaceSymbolResolveRequest.method]: protocol.WorkspaceSymbol;
    [protocol.CodeLensRequest.method]: protocol.CodeLensParams;
    [protocol.CodeLensResolveRequest.method]: protocol.CodeLens;
    [protocol.DocumentLinkRequest.method]: protocol.DocumentLinkParams;
    [protocol.DocumentLinkResolveRequest.method]: protocol.DocumentLink;
    [protocol.DocumentFormattingRequest.method]: protocol.DocumentFormattingParams;
    [protocol.DocumentRangeFormattingRequest.method]: protocol.DocumentRangeFormattingParams;
    [protocol.DocumentRangesFormattingRequest.method]: protocol.DocumentRangesFormattingParams;
    [protocol.DocumentOnTypeFormattingRequest.method]: protocol.DocumentOnTypeFormattingParams;
    [protocol.RenameRequest.method]: protocol.RenameParams;
    [protocol.FoldingRangeRequest.method]: protocol.FoldingRangeParams;
    [protocol.PrepareRenameRequest.method]: protocol.PrepareRenameParams;
    [protocol.ExecuteCommandRequest.method]: protocol.ExecuteCommandParams;
    [protocol.ApplyWorkspaceEditRequest.method]: protocol.ApplyWorkspaceEditParams;
    [protocol.InlayHintRequest.method]: protocol.InlayHintParams;
    [protocol.InlayHintResolveRequest.method]: protocol.InlayHint;
}

export interface MessageResponseType {
    [protocol.ShutdownRequest.method]: never;
    [protocol.RegistrationRequest.method]: void;
    [protocol.UnregistrationRequest.method]: void;
    [protocol.InitializeRequest.method]: protocol.InitializeResult<any>;
    [protocol.ConfigurationRequest.method]: protocol.LSPAny[] | null;
    [protocol.ShowMessageRequest.method]: protocol.MessageActionItem | null;
    [protocol.CompletionRequest.method]: protocol.CompletionList | protocol.CompletionItem[] | null;
    [protocol.CompletionResolveRequest.method]: protocol.CompletionItem;
    [protocol.HoverRequest.method]: protocol.Hover | null;
    [protocol.SignatureHelpRequest.method]: protocol.SignatureHelp | null;
    [protocol.DefinitionRequest.method]: protocol.Definition | protocol.LocationLink[] | null;
    [protocol.ReferencesRequest.method]: protocol.Location[] | null;
    [protocol.DocumentDiagnosticRequest.method]: protocol.DocumentDiagnosticReport;
    [protocol.DocumentHighlightRequest.method]: protocol.DocumentHighlight[] | null;
    [protocol.DocumentSymbolRequest.method]: protocol.DocumentSymbol[] | protocol.SymbolInformation[] | null;
    [protocol.CodeActionRequest.method]: (protocol.Command | protocol.CodeAction)[] | null;
    [protocol.CodeActionResolveRequest.method]: protocol.CodeAction;
    [protocol.WorkspaceSymbolRequest.method]: protocol.SymbolInformation[] | protocol.WorkspaceSymbol[] | null;
    [protocol.WorkspaceSymbolResolveRequest.method]: protocol.WorkspaceSymbol;
    [protocol.CodeLensRequest.method]: protocol.CodeLens[] | null;
    [protocol.CodeLensResolveRequest.method]: protocol.CodeLens;
    [protocol.DocumentLinkRequest.method]: protocol.DocumentLink[] | null;
    [protocol.DocumentLinkResolveRequest.method]: protocol.DocumentLink;
    [protocol.DocumentFormattingRequest.method]: protocol.TextEdit[] | null;
    [protocol.DocumentRangeFormattingRequest.method]: protocol.TextEdit[] | null;
    [protocol.DocumentRangesFormattingRequest.method]: protocol.TextEdit[] | null;
    [protocol.DocumentOnTypeFormattingRequest.method]: protocol.TextEdit[] | null;
    [protocol.FoldingRangeRequest.method]: protocol.FoldingRange[] | null;
    [protocol.RenameRequest.method]: protocol.WorkspaceEdit | null;
    [protocol.PrepareRenameRequest.method]: protocol.PrepareRenameResult | null;
    [protocol.ExecuteCommandRequest.method]: any;
    [protocol.ApplyWorkspaceEditRequest.method]: protocol.ApplyWorkspaceEditResult;
    [protocol.InlayHintRequest.method]: protocol.InlayHint[] | null;
    [protocol.InlayHintResolveRequest.method]: protocol.InlayHint;
}

export interface NotificationToParams {
    [protocol.InitializedNotification.method]: protocol.InitializedParams;
    [protocol.ExitNotification.method]: undefined;
    [protocol.DidOpenTextDocumentNotification.method]: protocol.DidOpenTextDocumentParams;
    [protocol.DidChangeTextDocumentNotification.method]: protocol.DidChangeTextDocumentParams;
    [protocol.DidCloseTextDocumentNotification.method]: protocol.DidCloseTextDocumentParams;
    [protocol.DidSaveTextDocumentNotification.method]: protocol.DidSaveTextDocumentParams;
    [protocol.WillSaveTextDocumentNotification.method]: protocol.WillSaveTextDocumentParams;
    [protocol.DidChangeWatchedFilesNotification.method]: protocol.DidChangeWatchedFilesParams;
    [protocol.PublishDiagnosticsNotification.method]: protocol.PublishDiagnosticsParams;
}