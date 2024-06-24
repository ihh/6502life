import { Icon } from '@iconify/react';
import csscolors from 'css-color-names';

const emptyIcon = "codicon:blank";
const unknownIcon = "mdi:circle";
const unknownRotatableIcon = "mdi:triangle";
const defaultPrefix = "game-icons";
const defaultColor = "white";

export default function Tile(props) {
    let { name, bitmap, hover, focusColor, style, ...otherProps } = props;
    if (name === '')
        name = 'orange:bee';
    // First colon-delimited field, if any, is interpreted as a color
    let color = defaultColor;
    if (name.indexOf(':') >= 0) {
        const a = name.split(':');
        name = a.slice(1).join(':');
        color = a[0];
    }
    // Rest of name is interpreted as a Game-Icons icon
    // Second colon-delimited field, if any, is interpreted as an Iconify namespace
    if (name.indexOf(':') < 0)
        name = defaultPrefix + ':' + name;
    let tileStyle = { ...style || {}, borderColor: focusColor };

    return (<Icon className={hover?'hover':''} icon={name} color={color} style={tileStyle} {...otherProps}/>);
}
