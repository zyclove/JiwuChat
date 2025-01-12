import { LogicalPosition } from "@tauri-apps/api/dpi";
import { listen } from "@tauri-apps/api/event";
import { appDataDir } from "@tauri-apps/api/path";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";
import { type as osType, platform } from "@tauri-apps/plugin-os";
import { open } from "@tauri-apps/plugin-shell";
import { restoreStateCurrent, saveWindowState, StateFlags } from "@tauri-apps/plugin-window-state";
import { useFlashTray } from "~/composables/tauri/window";

/**
 * Tauri事件
 */
export async function userTauriInit() {
  const setting = useSettingStore();
  try {
    const appPlatform = platform();
    if (!appPlatform)
      return;
    setting.appPlatform = appPlatform;
  }
  catch (error) {
    // console.warn(error);
    setting.appPlatform = "web";
    setting.osType = "web";
    return;
  }
  try {
    const osTypeName = osType();
    if (!osTypeName)
      return;
    setting.osType = osTypeName;
  }
  catch (error) {
    // console.warn(error);
    setting.appPlatform = "web";
    setting.osType = "web";
    return;
  }
  const isMobileSystem = ["android", "ios"].includes(setting.osType);

  let stopDebounced = null;
  // 1、初始化窗口状态
  if (!isMobileSystem) { // 非移动端才有该功能
    restoreStateCurrent(StateFlags.ALL);
    stopDebounced = watchDebounced(() => setting.isMobileSize, async () => {
      setTimeout(async () => {
        await saveWindowState(StateFlags.ALL);
      }, 200);
    }, {
      debounce: 1000,
    });
  }


  // msgbox 默认不调整
  const msgbox = WebviewWindow.getCurrent();
  if (msgbox.label === "msgbox" && useRoute().path !== "/msg") {
    navigateTo("/msg");
  }

  // 监听open_url事件
  const unListenOpenUrl = await listen<PayloadType>("open_url", (e) => {
    const url = e.payload.message; // 路径
    if (url)
      open(url);
  });
  // 监听路由事件
  const unListenRouter = await listen<PayloadType>("router", (e) => {
    const path = e.payload.message; // 路径
    if (path)
      navigateTo(path);
  });

  // 2、获取通知权限
  let permissionGranted = await isPermissionGranted();
  if (!permissionGranted) {
    const permission = await requestPermission();
    permissionGranted = permission === "granted";
    setting.sysPermission.isNotification = permissionGranted; // 更新通知权限状态
  }
  else {
    setting.sysPermission.isNotification = permissionGranted; // 更新通知权限状态
  }
  if (["android", "ios"].includes(setting.appPlatform)) // 非桌面端
    setting.settingPage.isTrayNotification = permissionGranted ? false : undefined;

  // 3、获取文件路径
  if (!await existsFile(setting.appDataDownloadDirUrl))
    setting.appDataDownloadDirUrl = `${await appDataDir()}\\downloads`;


  return () => {
    unListenRouter?.();
    unListenOpenUrl?.();
    stopDebounced?.();
  };
}

/**
 * 初始化用户信息
 */
export function useAuthInit() {
  const user = useUserStore();
  // 用于iframe嵌入快速登录
  const route = useRoute();
  const iframeToken = route.query.token;
  if (iframeToken && !user.isLogin) {
    let loading = {} as any;
    loading = ElLoading.service({ fullscreen: true, text: "正在登录，请稍等..." });
    user.onUserLogin(String(iframeToken), true, "/", () => {
      setTimeout(() => {
        loading?.close?.();
      }, 300);
    });
  }
  else {
    // 确认是否登录
    user.onCheckLogin();
  }
}

export const MSG_WEBVIEW_NAME = "msgbox";
export const MSG_WEBVIEW_WIDTH = 240;

/**
 * 初始化消息通知窗口 (仅限桌面端)
 */
export async function useMsgBoxWebViewInit() {
  let platformName = "web";
  const MSG_WEBVIEW_HEIGHT = ref(300);
  try {
    platformName = platform();
  }
  catch (error) {
    return;
  }
  if (!["windows", "linux", "macos"].includes(platformName))
    return;
  restoreStateCurrent(StateFlags.ALL);
  const chat = useChatStore();
  const setting = useSettingStore();
  const user = useUserStore();
  const ws = useWs();
  const isNewAllMsg = computed(() => chat.isNewMsg || ws.isNewMsg);

  // 监听消息通知事件
  const channel = new BroadcastChannel("main_channel");
  channel.addEventListener("message", handleChannelMsg);
  // 是否有新消息，控制图标闪烁
  const { start, stop, activeIcon, onlineUrl, offlineUrl } = await useFlashTray();
  watchDebounced([isNewAllMsg, () => setting.settingPage.isTrayNotification], async ([newAllMsg, isTrayNotification], oldVal) => {
    if (isTrayNotification !== true) {
      stop();
      return;
    }
    if (newAllMsg)
      start(true);
    else
      stop();
  }, {
    immediate: true,
    debounce: 300,
  });
  const online = useOnline();

  watch(() => user.isLogin && online.value, (newVal, oldVal) => {
    activeIcon.value = newVal ? onlineUrl : offlineUrl;
  }, {
    immediate: true,
  });

  // 判断是否已存在消息通知窗口
  const webview = await WebviewWindow.getByLabel(MSG_WEBVIEW_NAME);
  if (!webview)
    return;

  // 获取消息通知窗口
  const msgbox = await WebviewWindow.getByLabel("msgbox");
  if (msgbox) {
    msgbox?.innerSize().then((size) => {
      MSG_WEBVIEW_HEIGHT.value = size.height;
    });
  }
  // 监听点击事件消息通知事件
  const trayClickUnlisten = await listen("tray_click", async (event) => {
    const win = await WebviewWindow.getByLabel("main");
    if (!win)
      return;

    if (isNewAllMsg.value) {
      // 消费第一个未读消息
      const contact = chat.unReadContactList[0];
      chat.setContact(contact);
      if (contact && chat.theContact.roomId === contact?.roomId)
        chat.setReadList(contact?.roomId);
      await nextTick();
      chat.scrollBottom(false);
    }
    else {
      stop();
    }
  });

  // 鼠标移入托盘
  const trayMouseoverUnlisten = await listen("tray_mouseenter", async (event) => {
    if (!isNewAllMsg.value)
      return;
    if (useSettingStore().settingPage.isTrayNotification !== true) { // 未开启托盘通知
      return;
    }
    const win = await WebviewWindow.getByLabel("msgbox");
    if (!win)
      return;
    const position = event.payload as LogicalPosition;
    // const winPosition = await win.position();
    // console.log("winPosition", winPosition);

    const setting = useSettingStore();
    const screenSize = window.screen;
    const taskWidth = screenSize.width - screenSize.availWidth;
    const taskHeight = screenSize.height - screenSize.availHeight;
    if (setting.osType === "windows") {
      // 任务栏 上下左右四个位置
      let x = position.x - MSG_WEBVIEW_WIDTH / 2;
      let y = position.y - MSG_WEBVIEW_HEIGHT.value;
      if (x < 0) {
        x = taskWidth;
        y = position.y - MSG_WEBVIEW_HEIGHT.value / 2;
      }
      if (y < 0) {
        x = position.x - MSG_WEBVIEW_WIDTH / 2;
        y = taskHeight;
      }
      if (x + MSG_WEBVIEW_WIDTH > screenSize.availWidth) {
        x = screenSize.availWidth - MSG_WEBVIEW_WIDTH;
        y = position.y - MSG_WEBVIEW_HEIGHT.value / 2;
      }
      if (y + MSG_WEBVIEW_HEIGHT.value > screenSize.availHeight) {
        y = screenSize.availHeight - MSG_WEBVIEW_HEIGHT.value;
      }
      await win.setPosition(new LogicalPosition(x, y));
    }
    else if (setting.osType === "macos") {
      await win.setPosition(new LogicalPosition(position.x - MSG_WEBVIEW_WIDTH / 2, position.y));
    }
    await win.show();
    await win.setFocus();
  });

  return () => {
    stop();
    channel.removeEventListener("message", handleChannelMsg);
    trayMouseoverUnlisten?.();
    trayClickUnlisten?.();
  };
}

/**
 * 处理消息通知事件
 * @param event 事件
 * @returns void
 */
async function handleChannelMsg(event: MessageEvent) {
  const payload = event.data;
  const ws = useWs();
  const user = useUserStore();
  const chat = useChatStore();
  if (!payload)
    return;
  // 是否托盘通知
  const setting = useSettingStore();
  if (setting.settingPage.isTrayNotification !== true) {
    return;
  }
  const { type, data } = payload;
  const win = await WebviewWindow?.getByLabel("main");
  if (type === "readContact") { // 读取单个
    chat.setContact(chat.contactMap[data.roomId]);
    if (chat.theContact.roomId === data.roomId)
      chat.setReadList(data.roomId);
    if (win) {
      await navigateTo("/");
      await win?.show();
      await win.isMinimized() && await win.unminimize();
      await win?.setFocus();
      chat.scrollBottom(false);
    }
  }
  else if (type === "readAllContact") { // 读取全部
    await navigateTo("/");
    chat.unReadContactList.forEach((p) => {
      setMsgReadByRoomId(p.roomId, user.getToken).then((res) => {
        if (res.code !== StatusCode.SUCCESS)
          return false;
        p.unreadCount = 0;
        ws.wsMsgList.newMsg = ws.wsMsgList.newMsg.filter(k => k.message.roomId !== p.roomId);
        if (p.roomId === chat.theContact.roomId)
          chat.theContact.unreadCount = 0;
      }).catch(() => {
        console.warn("readAllContact error");
      });
      return p;
    });
  }
}
