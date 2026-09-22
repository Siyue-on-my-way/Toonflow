import { h, ref, render, nextTick } from "vue";
import { Dialog as TDialog } from "tdesign-vue-next";
import LibtvBindDialog from "@/components/libtvBindDialog.vue";

/**
 * 全局就地弹出「绑定 LibTV 账号」小浮层（复用设置页绑定向导的接口，不跳设置页）。
 *
 * 快创各处（模型选择器选中未绑定的 LibTV 模型、生成失败卡片上的 [重新绑定]）都从这里拉起。
 * resolve 值：
 *   true        → 绑定成功，调用方恢复之前的模型选择/刷新状态
 *   "switch"    → 用户点了「换用平台模型」，调用方清掉 LibTV 选择
 *   false       → 直接关掉浮层（选择保持原样，不阻断）
 */
export default function openLibtvBindDialog(options: { title?: string; showSwitchModel?: boolean } = {}): Promise<boolean | "switch"> {
  const { title, showSwitchModel } = options;
  return new Promise((resolve) => {
    const container = document.createElement("div");
    document.body.appendChild(container);

    const visible = ref(false);
    const bindRef = ref<InstanceType<typeof LibtvBindDialog>>();
    let done = false;

    const cleanup = () => {
      render(null, container);
      container.remove();
    };

    const finish = (bound: boolean | "switch") => {
      if (done) return;
      done = true;
      visible.value = false;
      renderDialog();
      resolve(bound);
    };

    const renderDialog = () => {
      const vnode = h(
        TDialog,
        {
          visible: visible.value,
          header: title ?? window.$t("common.bindLibtvAccount"),
          width: "480px",
          destroyOnClose: true,
          // 底部确认按钮走「完成绑定」；绑定成功后由弹层自己提示并关闭
          confirmBtn: window.$t("settings.libtv.bind"),
          cancelBtn: window.$t("common.cancel"),
          onConfirm: async () => {
            await bindRef.value?.onBind();
            if (bindRef.value?.isBound()) finish(true);
          },
          onClose: () => finish(false),
          onCloseBtnClick: () => finish(false),
          onClosed: () => cleanup(),
        },
        {
          default: () =>
            h(LibtvBindDialog, {
              ref: bindRef,
              showSwitchModel,
              onSuccess: () => finish(true),
              onSwitchModel: () => finish("switch"),
            }),
        },
      );
      // 继承主应用上下文，使全局注册的组件/指令可用
      const appContext = (document.querySelector("#app") as any)?.__vue_app__?._context;
      if (appContext) {
        vnode.appContext = appContext;
      }
      render(vnode, container);
    };

    renderDialog();
    nextTick(() => {
      visible.value = true;
      renderDialog();
    });
  });
}
