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
          guidance: '无法核对已发布资料，填写已停止；请检查下方错误提示。',
          action: 'rescan',
          actionLabel: '重新检查资料',
        };
  }
  if (status.publishedStatus === 'active') {
    return {
      statusLabel: ` · 正在使用已发布 v${status.publishedRevision}`,
      guidance: '只向服务端发送当前页的字段描述；资料草稿不会用于填写。',
      action: 'edit-profile',
      actionLabel: '编辑网申资料',
    };
  }
  if (status.hasPendingImport || status.hasUnpublishedDraft) {
    return {
      statusLabel: ' · 网申资料尚未发布',
      guidance: '网站上已有待审核或待发布内容；完成确认并发布后即可生成填写预览。',
      action: 'edit-profile',
      actionLabel: '继续整理并发布资料',
    };
  }
  return {
    statusLabel: ' · 尚无网申资料',
    guidance: '首次使用请在网站上传简历解析，或手工建立大简历并发布。',
    action: 'edit-profile',
    actionLabel: '上传简历或手工建立资料',
  };
}
