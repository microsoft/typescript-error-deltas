function replaceAll(message, oldStr, newStr) {
    let result = "";
    let index = 0;
    while (true) {
        const newIndex = message.indexOf(oldStr, index);
        if (newIndex < 0) {
            return index === 0
                ? message
                : result + message.substring(index);
        }
        result += message.substring(index, newIndex);
        result += newStr;
        index = newIndex + oldStr.length;
    }
}

replaceAll("aa", "a", "b");