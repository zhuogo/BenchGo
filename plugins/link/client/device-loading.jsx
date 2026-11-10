import React from 'react';
import { Loading } from '../../shared/client/ui/loading.jsx';
import css from './device-loading.css';

export function DeviceLoading({ label = '加载中' }) {
  return <><style>{css}</style><Loading className="dc-loading-state" label={label} /></>;
}
