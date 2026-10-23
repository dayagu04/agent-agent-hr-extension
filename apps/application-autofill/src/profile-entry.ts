import type { RemoteProfileStatus } from './remote-autofill';

export interface ProfileEntry {
  statusLabel: string;
  guidance: string;
  action: 'edit-profile' | 'rescan';
  actionLabel: string;
}

export function profileEntry(status: RemoteProfileStatus | null, errorStatus: number | null): ProfileEntry {
  if (!status) {
    return errorStatus === 404
      ? {
          statusLabel: ' · 网申资料功能尚未上线',
          guidance: '服务器尚未提供网申资料接口。当前不能上传资料或填写；请在功能上线后重试。',
          action: 'rescan',
          actionLabel: '重试资料服务',
        }
      : {
          statusLabel: ' · 资料服务暂不可用',
          guidance: '无法核对已保存的个人信息，填写已停止；请检查下方错误提示。',
          action: 'rescan',
          actionLabel: '重新检查资料',
        };
  }
  if (status.publishedStatus === 'active') {
    return {
      statusLabel: ` · 正在使用个人信息 v${status.publishedRevision}`,
      guidance: '只向服务端发送当前页的字段描述；未写入的简历解析结果不会用于填写。',
      action: 'edit-profile',
      actionLabel: '编辑网申资料',
    };
  }
  if (status.hasPendingImport) {
    return {
      statusLabel: ' · 简历解析结果待写入',
      guidance: '网站上已有解析预览，点击“一键写入个人信息”后即可生成填写预览。',
      action: 'edit-profile',
      actionLabel: '查看并写入个人信息',
    };
  }
  if (status.hasUnpublishedDraft) {
    return {
      statusLabel: ' · 个人信息待保存',
      guidance: '网站上已有个人信息，点击“保存个人信息”后即可生成填写预览。',
      action: 'edit-profile',
      actionLabel: '保存个人信息',
    };
  }
  return {
    statusLabel: ' · 尚无网申资料',
    guidance: '首次使用请在网站上传简历并一键写入，或手工建立大简历并保存。',
    action: 'edit-profile',
    actionLabel: '上传简历或手工建立资料',
  };
}
