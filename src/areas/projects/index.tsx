import { FolderKanban } from 'lucide-react';
import { Placeholder, SideHead } from '../../components/kit';


export function ProjectsView() {
  return <Placeholder title="Projects" />;
}

export function ProjectView() {
  return <Placeholder title="Project" />;
}

export function ProjectsSide() {
  return <SideHead icon={<FolderKanban size={18} />} title="Projects" />;
}

export function ProjectsContext() {
  return null;
}
