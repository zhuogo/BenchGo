import React from 'react';
import { Button } from '../../shared/client/ui/index.jsx';
import { Select } from '../../shared/client/select.jsx';
import { isReasoningMapping, reasoningError, reasoningLevelLabels, reasoningLevels, toggleReasoningLevel, withModelReasoning } from './model-reasoning-state.mjs';

export function ModelReasoningEditor({ model, inherited, retained, defaultEffort, position, disabled, onChange, styles }) {
  const value = model.reasoningEfforts;
  const configured = isReasoningMapping(value) ? value : undefined;
  const defaults = inherited;
  const available = { ...defaults, ...retained, ...configured };
  const selected = value === undefined ? defaults ?? {} : configured ?? {};
  const levels = reasoningLevels.filter(level => Object.hasOwn(available, level));
  const error = reasoningError(value);
  const hasThinking = levels.some(level => level !== 'off' && Object.hasOwn(selected, level));
  const [editing, setEditing] = React.useState('');
  const [wire, setWire] = React.useState('');
  const [show, setShow] = React.useState(false);
  const editable = reasoningLevels.filter(level => level !== 'off' || hasThinking);
  function edit(level) {
    setEditing(level);
    setWire(available[level] ?? '');
    setShow(true);
  }
  function apply() {
    const next = { ...selected, [editing]: editing === 'off' && !wire.trim() ? null : wire };
    onChange(withModelReasoning(model, next), { ...available, ...next });
    setShow(false);
  }

  return <fieldset disabled={disabled} className={styles.modelInputTypes}>
    <legend className={styles.modelFieldLabel}>思考档位</legend>
    <div className="cmd-model-capabilities">
      {levels.map(level => {
        const active = Object.hasOwn(selected, level);
        const providerValue = available[level];
        const custom = level !== 'off' && providerValue && providerValue !== level && !(level === 'minimal' && providerValue === 'min');
        const label = (custom ? reasoningLevelLabels[level] + ' · ' + providerValue : reasoningLevelLabels[level]) + (active && level === defaultEffort ? '（默认）' : '');
        return <Button key={level} variant="outline" size="sm"
          aria-label={'模型 ' + position + ' 思考档位 ' + label} aria-pressed={active}
          disabled={disabled || (level === 'off' && !hasThinking && !active)}
          onClick={() => {
            onChange(withModelReasoning(model, toggleReasoningLevel(selected, available, defaults, level)), available);
          }}>
          {label}
        </Button>;
      })}
      <Button variant="ghost" size="sm" disabled={disabled} onClick={() => edit(editable.find(level => !Object.hasOwn(selected, level)) ?? 'high')}>自定义档位</Button>
    </div>
    {show && <div className="cmd-model-reasoning-edit">
      <Select aria-label="映射档位" value={editing} onChange={event => edit(event.target.value)}>
        {editable.map(level => <option key={level} value={level}>{reasoningLevelLabels[level]}</option>)}
      </Select>
      <input className={styles.input} aria-label="供应商档位值" placeholder={editing === 'off' ? '留空时省略思考参数' : '供应商档位值'}
        value={wire} onChange={event => setWire(event.target.value)} />
      <Button variant="outline" size="sm" disabled={editing !== 'off' && !wire.trim()} onClick={apply}>应用档位</Button>
      <Button variant="ghost" size="sm" onClick={() => setShow(false)}>取消编辑</Button>
    </div>}
    {error && <p role="alert" className={styles.error}>{error}</p>}
  </fieldset>;
}
