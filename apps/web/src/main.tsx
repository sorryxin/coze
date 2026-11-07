import { createRoot } from 'react-dom/client';
import { ClassroomPage } from './classroom.tsx';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');

// 不套 StrictMode：reducer 里的副作用（发请求 / 追加气泡）会被执行两次，
// 课堂这种「一次输入只能产生一轮」的场景必须保证单次执行。
createRoot(root).render(<ClassroomPage />);
