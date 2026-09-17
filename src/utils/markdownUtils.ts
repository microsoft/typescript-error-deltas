const markdownReplacements: readonly [RegExp, string][] = [
    [/\*/g, "\\*"],
    [/#/g, "\\#"],
    [/\//g, "\\/"],
    [/\(/g, "\\("],
    [/\)/g, "\\)"],
    [/\[/g, "\\["],
    [/\]/g, "\\]"],
    [/</g, "&lt;"],
    [/>/g, "&gt;"],
    [/_/g, "\\_"],
    [/`/g, "\\`"],
];

export function escapeMarkdown(s: string): string {
    return markdownReplacements.reduce((escaped, [pattern, replacement]) => escaped.replace(pattern, replacement), s);
}

export function asMarkdownInlineCode(s: string) {
    let backticks = "`";
    let space = "";
    while (s.includes(backticks)) {
        backticks += "`";
        space = " "
    }
    return `${backticks}${space}${s}${space}${backticks}`;
}
