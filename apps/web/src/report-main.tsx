import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ReportPage } from './report.tsx';
import './styles.css';
import './report.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');

createRoot(root).render(
  <StrictMode>
    <ReportPage />
  </StrictMode>,
);
