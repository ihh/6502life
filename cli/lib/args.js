// Minimal process.argv parser
// Handles --flag value, --flag=value, and positional args

export function parseArgs(argv = process.argv.slice(2)) {
    const flags = {};
    const positional = [];

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg.startsWith('--')) {
            const eqIdx = arg.indexOf('=');
            if (eqIdx >= 0) {
                flags[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
            } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
                flags[arg.slice(2)] = argv[i + 1];
                i++;
            } else {
                flags[arg.slice(2)] = true;
            }
        } else {
            positional.push(arg);
        }
    }

    return { flags, positional };
}

export function getFlag(flags, name, defaultValue = undefined) {
    return name in flags ? flags[name] : defaultValue;
}

export function getIntFlag(flags, name, defaultValue) {
    if (!(name in flags)) return defaultValue;
    const v = parseInt(flags[name], 10);
    if (isNaN(v)) {
        console.error(`Error: --${name} requires an integer`);
        process.exit(1);
    }
    return v;
}

export function getCellFlag(flags, name, defaultI = 0, defaultJ = 0) {
    if (!(name in flags)) return [defaultI, defaultJ];
    const parts = flags[name].split(',').map(s => parseInt(s.trim(), 10));
    if (parts.length !== 2 || parts.some(isNaN)) {
        console.error(`Error: --${name} requires i,j format`);
        process.exit(1);
    }
    return parts;
}
