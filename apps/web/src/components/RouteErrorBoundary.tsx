import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button, Result } from "antd";

type Props = { children: ReactNode };
type State = { error: Error | null };

/** Prevent a single page crash from becoming a blank white screen. */
export class RouteErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[RouteErrorBoundary]", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <Result
          status="error"
          title="页面渲染出错"
          subTitle={this.state.error.message}
          extra={
            <Button
              type="primary"
              onClick={() => {
                this.setState({ error: null });
                window.location.assign("/targets");
              }}
            >
              返回目标管理
            </Button>
          }
        />
      );
    }
    return this.props.children;
  }
}
