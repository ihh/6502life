import { useState, useCallback } from 'react';
import { assembleTo } from '../engine/assembler.js';
import { writeCellBytes } from '../engine/boardEngine.js';

const PRESETS = {
    '': '-- Select preset --',
    nop: 'NOP sled',
    counter: 'Simple counter',
    copier: 'Page copier',
};

const PRESET_CODE = {
    nop: `; NOP sled - does nothing
@loop:
  NOP
  JMP @loop`,
    counter: `; Simple counter - increments A
  LDA #$00
@loop:
  CLC
  ADC #$01
  STA $00
  JMP @loop`,
    copier: `; Copy page 0 to neighbor cell 2 (East)
  LDX #$00
@loop:
  LDA $00,X
  STA $0800,X
  INX
  BNE @loop
  BRK
  .byte $00`,
};

export default function AssemblyEditor({ controller, selectedCell, onAssemble }) {
    const [source, setSource] = useState('; Write 6502 assembly here\n  NOP\n  BRK\n  .byte $00\n');
    const [error, setError] = useState(null);
    const [assembled, setAssembled] = useState(null);

    const handleAssemble = useCallback(async () => {
        if (!selectedCell) {
            setError('Select a cell first');
            return;
        }
        setError(null);
        setAssembled(null);
        try {
            const len = await assembleTo(
                source,
                controller.memory,
                selectedCell.i,
                selectedCell.j,
                0
            );
            setAssembled(`${len} bytes written to (${selectedCell.i}, ${selectedCell.j})`);
            onAssemble();
        } catch (e) {
            setError(e.message);
        }
    }, [source, controller, selectedCell, onAssemble]);

    const handlePreset = useCallback((key) => {
        if (PRESET_CODE[key]) {
            setSource(PRESET_CODE[key]);
        }
    }, []);

    return (
        <section>
            <h3>Assembly Editor</h3>
            <div style={{ display: 'flex', gap: '6px', marginBottom: '6px' }}>
                <select onChange={e => handlePreset(e.target.value)} style={{ flex: 1 }}>
                    {Object.entries(PRESETS).map(([k, v]) => (
                        <option key={k} value={k}>{v}</option>
                    ))}
                </select>
            </div>
            <textarea
                value={source}
                onChange={e => setSource(e.target.value)}
                rows={8}
                style={{ width: '100%', tabSize: 2 }}
                spellCheck={false}
            />
            <div style={{ display: 'flex', gap: '6px', marginTop: '6px', alignItems: 'center' }}>
                <button onClick={handleAssemble}>
                    Assemble & Load
                </button>
                {error && <span style={{ color: 'var(--danger)', fontSize: '12px' }}>{error}</span>}
                {assembled && <span style={{ color: 'var(--success)', fontSize: '12px' }}>{assembled}</span>}
            </div>
        </section>
    );
}
