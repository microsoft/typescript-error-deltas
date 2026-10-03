export function asMarkdownInlineCode(s: string) {
    let backticks = "`";
    let space = "";
    while (s.includes(backticks)) {
        backticks += "`";
        space = " "
    }
    return `${backticks}${space}${s}${space}${backticks}`;
}

export function formatPrComparison(oldVersion: string | undefined, newVersion: string | undefined, prNumber: number): string {
    if (oldVersion && /^[0-9a-f]{40}$/.test(oldVersion) && newVersion === `refs/pull/${prNumber}/merge`) {
        return `${asMarkdownInlineCode("baseline")} and ${asMarkdownInlineCode("pr")}`;
    }
    return `${asMarkdownInlineCode(oldVersion ?? "old")} and ${asMarkdownInlineCode(newVersion ?? "new")}`;
}

export function formatVersionComparison(newVersion: string, oldVersion: string | undefined): string {
    return oldVersion ? `${newVersion} vs ${oldVersion}` : newVersion;
}
