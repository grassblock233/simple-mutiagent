import { Icon } from "./studio-ui";
import { cx } from "./studio-styles";

export function WelcomePanel({
  onProject,
  onTemplate,
  onHistory,
  onContinue,
  workspace,
}: {
  onProject: () => void;
  onTemplate: (template: "full" | "review") => void;
  onHistory: () => void;
  onContinue: () => void;
  workspace?: string;
}) {
  return (
    <section className={cx("welcome")} aria-label="欢迎工作台">
      <div className={cx("welcome-content")}>
        <div className={cx("welcome-emblem")}>
          <Icon name="workflow" />
        </div>
        <p className={cx("eyebrow")}>YOUR LOCAL AGENT WORKSPACE</p>
        <h1>Simple Workflow</h1>
        <p className={cx("welcome-description")}>
          把审查、修复与复审，连接成你的工作流。
        </p>
        <div className={cx("welcome-columns")}>
          <div>
            <h2>开始</h2>
            <button onClick={onProject}>
              <Icon name="folder" />
              <span>打开本地项目</span>
              <Icon name="arrow-right" />
            </button>
            <button onClick={() => onTemplate("full")}>
              <Icon name="workflow" />
              <span>创建完整流程</span>
              <small>审查 → 修复 → 复审</small>
            </button>
            <button onClick={() => onTemplate("review")}>
              <Icon name="search" />
              <span>创建仅审查流程</span>
            </button>
            <button onClick={onHistory}>
              <Icon name="history" />
              <span>查看运行历史</span>
            </button>
          </div>
          <div className={cx("welcome-resume")}>
            <h2>工作空间</h2>
            <p>{workspace ? "当前项目" : "从本地项目开始"}</p>
            <p className={cx("welcome-project")} title={workspace}>
              {workspace ?? "打开项目，选择文件范围，再连接你的 Agent 节点。"}
            </p>
            <button onClick={onContinue}>
              继续编辑工作流 <Icon name="arrow-right" />
            </button>
          </div>
        </div>
        <div className={cx("welcome-footnote")}>
          <Icon name="layers" />
          <span>可视化编排</span>
          <span>·</span>
          <span>逐次命令审核</span>
          <span>·</span>
          <span>差异与运行记录</span>
        </div>
      </div>
    </section>
  );
}
