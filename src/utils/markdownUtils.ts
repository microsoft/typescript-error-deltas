export function asMarkdownInlineCode(s: string) {
    let backticks = "`";
    let space = "";
    while (s.includes(backticks)) {
        backticks += "`";
        space = " "
    }
    return `${backticks}${space}${s}${space}${backticks}`;
}
