import GitContent from "@/components/GitContent";

interface GitPaneProps {
  gitPath: string;
  configBranch?: string;
}

export default function GitPane({ gitPath, configBranch }: GitPaneProps) {
  return <GitContent gitPath={gitPath} configBranch={configBranch} />;
}
