import { cellIndex } from '../memory.js';
import { range } from '../util.js';

const hex2 = (num) => num.toString(16).padStart(2, '0').toUpperCase();

const xr = range(-3,3);
const yr = xr.slice(0).reverse();
console.log("<table>");
console.log ('<tr> <td></td>' + xr.map((x) => `<td> x=${x} </td>`).join('')+' </tr>');
console.log (yr.map((y) => {
    return `<tr> <td> y=${y} </td>` + xr.map((x) => {
        const n = cellIndex[x+3][y+3];
        return '<td>' + ((x==0 && y==0) ? '<b>' : '') + `Cell #${n} <br> Coords (${x},${y}) <br> Addr ${hex2(n*4)}00..${hex2(n*4+3)}FF` + ((x==0 && y==0) ? '</b>' : '') + '</td>';
    }).join('')+ " </tr>\n";
}).join('') + "</table>");
