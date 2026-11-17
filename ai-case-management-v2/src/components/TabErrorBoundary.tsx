import { Component, ReactNode, ErrorInfo } from "react";
import { Button } from "@/components/ui/button";
import { AlertTriangle } from "lucide-react";

interface Props {
  children: ReactNode;
  tabName: string;
}

interface State {
  hasError: boolean;
  error?: Error;
  resetKey: number;
}

export class TabErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, resetKey: 0 };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[TabErrorBoundary:${this.props.tabName}]`, error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center h-64 gap-4 text-muted-foreground">
          <AlertTriangle className="h-8 w-8 text-destructive" />
          <p className="text-sm font-medium text-foreground">
            [{this.props.tabName}] 탭에서 오류가 발생했어요.
          </p>
          {this.state.error?.message && (
            <p className="text-xs text-muted-foreground max-w-md text-center break-all">
              {this.state.error.message.slice(0, 120)}
            </p>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              this.setState((s) => ({ hasError: false, error: undefined, resetKey: s.resetKey + 1 }))
            }
          >
            다시 시도
          </Button>
        </div>
      );
    }
    // resetKey가 바뀌면 자식 트리를 완전히 remount하여 에러 상태를 초기화한다.
    return <div key={this.state.resetKey} style={{ display: "contents" }}>{this.props.children}</div>;
  }
}
