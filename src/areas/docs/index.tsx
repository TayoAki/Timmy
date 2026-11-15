import { FileText } from 'lucide-react';
import { Placeholder, SideHead } from '../../components/kit';


export function DocsView() {
  return <Placeholder title="Docs" />;
}

export function FileView() {
  return <Placeholder title="File" />;
}

export function DocsSide() {
  return <SideHead icon={<FileText size={18} />} title="Docs" />;
}

export function DocsContext() {
  return null;
}

export function FileContext() {
  return null;
}
