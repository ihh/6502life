/**
 * Minimal 6502 disassembler for the cell inspector.
 */

const MNEMONICS = [
    'BRK','ORA','JAM','SLO','NOP','ORA','ASL','SLO','PHP','ORA','ASL','ANC','NOP','ORA','ASL','SLO',
    'BPL','ORA','JAM','SLO','NOP','ORA','ASL','SLO','CLC','ORA','NOP','SLO','NOP','ORA','ASL','SLO',
    'JSR','AND','JAM','RLA','BIT','AND','ROL','RLA','PLP','AND','ROL','ANC','BIT','AND','ROL','RLA',
    'BMI','AND','JAM','RLA','NOP','AND','ROL','RLA','SEC','AND','NOP','RLA','NOP','AND','ROL','RLA',
    'RTI','EOR','JAM','SRE','NOP','EOR','LSR','SRE','PHA','EOR','LSR','ALR','JMP','EOR','LSR','SRE',
    'BVC','EOR','JAM','SRE','NOP','EOR','LSR','SRE','CLI','EOR','NOP','SRE','NOP','EOR','LSR','SRE',
    'RTS','ADC','JAM','RRA','NOP','ADC','ROR','RRA','PLA','ADC','ROR','ARR','JMP','ADC','ROR','RRA',
    'BVS','ADC','JAM','RRA','NOP','ADC','ROR','RRA','SEI','ADC','NOP','RRA','NOP','ADC','ROR','RRA',
    'NOP','STA','NOP','SAX','STY','STA','STX','SAX','DEY','NOP','TXA','---','STY','STA','STX','SAX',
    'BCC','STA','JAM','---','STY','STA','STX','SAX','TYA','STA','TXS','---','---','STA','---','---',
    'LDY','LDA','LDX','LAX','LDY','LDA','LDX','LAX','TAY','LDA','TAX','---','LDY','LDA','LDX','LAX',
    'BCS','LDA','JAM','LAX','LDY','LDA','LDX','LAX','CLV','LDA','TSX','---','LDY','LDA','LDX','LAX',
    'CPY','CMP','NOP','DCP','CPY','CMP','DEC','DCP','INY','CMP','DEX','AXS','CPY','CMP','DEC','DCP',
    'BNE','CMP','JAM','DCP','NOP','CMP','DEC','DCP','CLD','CMP','NOP','DCP','NOP','CMP','DEC','DCP',
    'CPX','SBC','NOP','ISC','CPX','SBC','INC','ISC','INX','SBC','NOP','SBC','CPX','SBC','INC','ISC',
    'BEQ','SBC','JAM','ISC','NOP','SBC','INC','ISC','SED','SBC','NOP','ISC','NOP','SBC','INC','ISC',
];

// Addressing mode per opcode: 0=imp 1=imm 2=zpg 3=zpx 4=zpy 5=abs 6=abx 7=aby 8=inx 9=iny 10=rel 11=ind 12=acc
const MODES = [
    0,8,0,8,2,2,2,2,0,1,12,1,5,5,5,5, 10,9,0,9,3,3,3,3,0,7,0,7,6,6,6,6,
    5,8,0,8,2,2,2,2,0,1,12,1,5,5,5,5, 10,9,0,9,3,3,3,3,0,7,0,7,6,6,6,6,
    0,8,0,8,2,2,2,2,0,1,12,1,5,5,5,5, 10,9,0,9,3,3,3,3,0,7,0,7,6,6,6,6,
    0,8,0,8,2,2,2,2,0,1,12,1,11,5,5,5,10,9,0,9,3,3,3,3,0,7,0,7,6,6,6,6,
    1,8,1,8,2,2,2,2,0,1,0,1,5,5,5,5,  10,9,0,9,3,3,4,4,0,7,0,7,6,6,7,7,
    1,8,1,8,2,2,2,2,0,1,0,1,5,5,5,5,  10,9,0,9,3,3,4,4,0,7,0,7,6,6,7,7,
    1,8,1,8,2,2,2,2,0,1,0,1,5,5,5,5,  10,9,0,9,3,3,3,3,0,7,0,7,6,6,6,6,
    1,8,1,8,2,2,2,2,0,1,0,1,5,5,5,5,  10,9,0,9,3,3,3,3,0,7,0,7,6,6,6,6,
];

const SIZES = [1,2,2,2,2,3,3,3,2,2,2,3,1]; // by mode

export function disassemble(mem, startPC, nLines, addrMask = 0x7FF) {
    const lines = [];
    let pc = startPC & addrMask;
    for (let i = 0; i < nLines; i++) {
        const addr = pc;
        const opcode = mem[pc & addrMask];
        const mn = MNEMONICS[opcode];
        const mode = MODES[opcode];
        const size = SIZES[mode];
        const op1 = mem[(pc + 1) & addrMask];
        const op2 = mem[(pc + 2) & addrMask];

        let operand = '';
        switch (mode) {
            case 0:  operand = ''; break; // implied
            case 1:  operand = ' #$' + hex(op1); break;
            case 2:  operand = ' $' + hex(op1); break;
            case 3:  operand = ' $' + hex(op1) + ',X'; break;
            case 4:  operand = ' $' + hex(op1) + ',Y'; break;
            case 5:  operand = ' $' + hex16(op1 | (op2 << 8)); break;
            case 6:  operand = ' $' + hex16(op1 | (op2 << 8)) + ',X'; break;
            case 7:  operand = ' $' + hex16(op1 | (op2 << 8)) + ',Y'; break;
            case 8:  operand = ' ($' + hex(op1) + ',X)'; break;
            case 9:  operand = ' ($' + hex(op1) + '),Y'; break;
            case 10: { const off = op1 >= 128 ? op1 - 256 : op1; operand = ' $' + hex16((pc + 2 + off) & 0xFFFF); break; }
            case 11: operand = ' ($' + hex16(op1 | (op2 << 8)) + ')'; break;
            case 12: operand = ' A'; break;
        }

        lines.push({ addr, size, text: hex16(addr) + ': ' + mn + operand });
        pc = (pc + size) & addrMask;
    }
    return lines;
}

function hex(v) { return v.toString(16).toUpperCase().padStart(2, '0'); }
function hex16(v) { return v.toString(16).toUpperCase().padStart(4, '0'); }
