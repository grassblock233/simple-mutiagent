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
  onTemplate: () => void;
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
        <h1>Simple Workflow</h1>
        <div className={cx("welcome-columns")}>
          <div>
            <h2>开始</h2>
            <button onClick={onProject}>
              <Icon name="folder" />
              <span>打开本地项目</span>
              <Icon name="arrow-right" />
            </button>
            <button onClick={onTemplate}>
              <Icon name="workflow" />
              <span>创建单轮修复流程</span>
              <small>最多修复一次，复审后输出</small>
            </button>
            <button onClick={onHistory}>
              <Icon name="history" />
              <span>查看运行历史</span>
            </button>
          </div>
          <div className={cx("welcome-resume")}>
            <h2>工作空间</h2>
            <p className={cx("welcome-project")} title={workspace}>
              {workspace ?? "未打开项目"}
            </p>
            <button onClick={onContinue}>
              继续编辑工作流 <Icon name="arrow-right" />
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
