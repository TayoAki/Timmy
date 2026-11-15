import { HardDrive } from 'lucide-react';
import { Placeholder, SideHead } from '../../components/kit';


export function FilesView() {
  return <Placeholder title="Files" />;
}

export function FilesSide() {
  return <SideHead icon={<HardDrive size={18} />} title="My Drive" />;
}

export function FilesContext() {
  return null;
}
