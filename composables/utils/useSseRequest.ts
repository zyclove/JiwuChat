import type { Result } from "~/types/result";

/**
 * SSE 请求选项
 */
interface SseRequestOptions {
  /** 请求URL (不包含BaseUrl) */
  url: string;
  /** 请求方法，默认为 POST */
  method?: "GET" | "POST";
  /** 请求体 */
  body?: any;
  /** 自定义请求头 */
  headers?: Record<string, string>;
  /** 是否需要授权 */
  needAuth?: boolean;
  /** 是否显示错误日志 */
  showErrorLog?: boolean;
  /** 成功回调 */
  onSuccess?: (data: string) => void;
  /** 错误回调 */
  onError?: (error: any) => void;
  /** 完成回调 */
  onComplete?: () => void;
  /** 数据处理函数 */
  processData?: (text: string) => string;
}

/**
 * SSE 响应处理器
 */
interface SseResponseHandler<T> {
  /** 取消请求 */
  cancel: () => void;
  /** 响应数据 */
  data: Ref<T | null>;
  /** 是否加载中 */
  loading: Ref<boolean>;
}

/**
 * 通用 SSE 请求工具
 */
export function useSseRequest<T = string>() {
  const user = useUserStore();

  /**
   * 发起 SSE 请求
   * @param options 请求选项
   * @param reg 数据处理正则
   * @returns SSE 响应处理器
   */
  function request(options: SseRequestOptions, reg = /data:|\n/g): SseResponseHandler<T> {
    const data = ref<T | null>(null) as Ref<T | null>;
    const loading = ref(true);
    let abortController: AbortController | null = new AbortController();

    // 默认数据处理函数 - 移除 data: 前缀和换行符
    const defaultProcessData = (text: string) => text.replaceAll(reg, "");
    const processData = options.processData || defaultProcessData;

    // 构建请求头
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Accept": "*/*",
      ...options.headers || {},
    };

    // 添加授权头
    if (options.needAuth !== false) {
      const token = user.getToken;
      if (token) {
        headers.Authorization = token;
      }
      else {
        loading.value = false;
        return {
          cancel: () => {},
          data,
          loading,
        };
      }
    }
    const showErrorLog = options.showErrorLog === undefined ? true : options.showErrorLog;

    // 发起请求
    fetch(`${BaseUrl}${options.url}`, {
      method: options.method || "POST",
      body: options.body ? JSON.stringify(options.body) : undefined,
      headers,
      signal: abortController.signal,
    }).then(async (resp) => {
      if (!resp.ok) {
        const errorText = await resp.text();
        console.log("SSE 请求失败:", errorText);
        throw new Error("请求失败，请稍后重试！");
      }

      if (!resp.body) {
        throw new Error("请求失败，流式响应体为空！");
      }

      const encoder = new TextDecoder("utf-8");

      // 检查是否为 SSE 响应
      const contentType = resp.headers.get("Content-Type");
      if (!contentType?.includes("text/event-stream")) {
        const bodyTxt = await resp.body.getReader().read();
        const text = encoder.decode(bodyTxt.value);
        const res = JSON.parse(text) as Result<null>;
        if (res.code !== StatusCode.SUCCESS) {
          checkResponse(res);
          throw new Error(res.message);
        }
        return;
      }

      // 处理 SSE 流
      const reader = resp.body.getReader();
      let accumulatedData = "";

      function processStream({ done, value }: ReadableStreamReadResult<Uint8Array>): Promise<void> {
        if (done) {
          options.onComplete?.();
          loading.value = false;
          return Promise.resolve();
        }

        try {
          // 解码并处理数据
          const text = encoder.decode(value);
          const processedText = processData(text);

          // 累积数据
          accumulatedData += processedText;
          data.value = accumulatedData as unknown as T;

          // 调用成功回调
          options.onSuccess?.(processedText);

          // 继续读取
          return reader.read().then(processStream);
        }
        catch (e) {
          options.onError?.(e);
          loading.value = false;
          return Promise.reject(e);
        }
      }

      // 开始读取流
      reader.read().then(processStream).catch((e) => {
        if (e.name !== "AbortError") {
          options.onError?.(e);
          console.error(e);
          showErrorLog && ElMessage.error("流式请求解析失败！");
        }
      }).finally(() => {
        loading.value = false;
        abortController = null;
      });
    }).catch((e) => {
      if (e.name !== "AbortError") {
        options.onError?.(e);
        console.error(e);
      }
      loading.value = false;
      abortController = null;
    });

    // 返回控制器
    return {
      cancel: () => {
        if (abortController) {
          abortController.abort();
          abortController = null;
          loading.value = false;
        }
      },
      data,
      loading,
    };
  }

  return {
    request,
  };
}
