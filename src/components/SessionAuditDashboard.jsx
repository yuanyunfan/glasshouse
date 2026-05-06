import React from 'react';
import { Alert, Button, Collapse, ConfigProvider, Progress, Spin, Tag, message } from 'antd';
import { CheckCircleOutlined, CloseCircleOutlined, DashboardOutlined, ReloadOutlined, WarningOutlined } from '@ant-design/icons';
import { apiUrl } from '../utils/apiUrl';
import { t } from '../i18n';
import styles from './SessionAuditDashboard.module.css';

function currentAuditId() {
  const parts = window.location.pathname.split('/').filter(Boolean);
  return parts[1] || '';
}

function pageUrl(path) {
  const params = new URLSearchParams(window.location.search);
  const token = params.get('token');
  return token ? `${path}?token=${encodeURIComponent(token)}` : path;
}

function statusMeta(status) {
  if (status === 'pass') return { color: 'success', icon: <CheckCircleOutlined />, label: t('ui.audit.status.pass') };
  if (status === 'fail') return { color: 'error', icon: <CloseCircleOutlined />, label: t('ui.audit.status.fail') };
  return { color: 'warning', icon: <WarningOutlined />, label: t('ui.audit.status.needsAttention') };
}

function severityColor(severity) {
  if (severity === 'critical') return 'red';
  if (severity === 'high') return 'volcano';
  if (severity === 'medium') return 'orange';
  if (severity === 'low') return 'blue';
  return 'default';
}

function formatNumber(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n.toLocaleString() : '0';
}

function formatDate(value) {
  if (!value) return '-';
  try { return new Date(value).toLocaleString(); } catch { return String(value); }
}

function scorePercent(value) {
  if (value == null || Number.isNaN(Number(value))) return null;
  return Math.max(0, Math.min(100, Math.round((Number(value) / 5) * 100)));
}

export default class SessionAuditDashboard extends React.Component {
  state = {
    auditId: currentAuditId(),
    loading: true,
    rerunLoading: false,
    audit: null,
    error: null,
  };

  componentDidMount() {
    this.loadAudit();
    this.openEvents();
  }

  componentWillUnmount() {
    if (this.events) this.events.close();
  }

  loadAudit = async () => {
    const { auditId } = this.state;
    if (!auditId) {
      this.setState({ loading: false, error: t('ui.audit.errorMissingId') });
      return;
    }
    try {
      const res = await fetch(apiUrl(`/api/session-audits/${encodeURIComponent(auditId)}`));
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t('ui.audit.errorLoad'));
      this.setState({ audit: data, loading: false, error: null });
    } catch (err) {
      this.setState({ loading: false, error: err.message || t('ui.audit.errorLoad') });
    }
  };

  openEvents() {
    const { auditId } = this.state;
    if (!auditId || !window.EventSource) return;
    this.events = new EventSource(apiUrl(`/api/session-audits/${encodeURIComponent(auditId)}/events`));
    this.events.addEventListener('status', (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.audit) this.setState({ audit: { auditId, ...data.audit }, loading: false, error: null });
        if (data.status === 'complete' || data.status === 'failed') this.events.close();
      } catch {}
    });
    this.events.addEventListener('error', () => {
      if (this.events) this.events.close();
    });
  }

  handleRerun = async () => {
    const audit = this.state.audit;
    const source = audit?.metadata?.source;
    if (!source) return;
    const body = { provider: source.sourceProvider || 'claude', force: true };
    if (source.trustedSourceType === 'local-log' && source.sourceSessionKey?.startsWith('local-log:')) {
      body.source = { type: 'local-log', file: source.sourceSessionKey.slice('local-log:'.length) };
    }
    this.setState({ rerunLoading: true });
    try {
      const res = await fetch(apiUrl('/api/session-audits'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t('ui.audit.errorRerun'));
      window.location.href = pageUrl(`/session-quality-audit/${encodeURIComponent(data.auditId)}`);
    } catch (err) {
      message.error(err.message || t('ui.audit.errorRerun'));
      this.setState({ rerunLoading: false });
    }
  };

  renderMetric(label, value, detail = null) {
    return (
      <div className={styles.metric}>
        <div className={styles.metricValue}>{value}</div>
        <div className={styles.metricLabel}>{label}</div>
        {detail && <div className={styles.metricDetail}>{detail}</div>}
      </div>
    );
  }

  renderScores(report) {
    const scores = report?.categoryScores || {};
    const items = [
      ['taskAlignment', t('ui.audit.score.taskAlignment')],
      ['toolUse', t('ui.audit.score.toolUse')],
      ['technicalCorrectness', t('ui.audit.score.technicalCorrectness')],
      ['verificationQuality', t('ui.audit.score.verificationQuality')],
      ['safetyAndPermissions', t('ui.audit.score.safetyAndPermissions')],
      ['communicationQuality', t('ui.audit.score.communicationQuality')],
      ['contextEfficiency', t('ui.audit.score.contextEfficiency')],
      ['projectRuleCompliance', t('ui.audit.score.projectRuleCompliance')],
    ];
    return (
      <div className={styles.scoreGrid}>
        {items.map(([key, label]) => {
          const pct = scorePercent(scores[key]);
          return (
            <div key={key} className={styles.scoreRow}>
              <div className={styles.scoreLabel}>{label}</div>
              {pct == null ? (
                <span className={styles.scoreMuted}>{t('ui.audit.scoreReviewerRequired')}</span>
              ) : (
                <>
                  <Progress percent={pct} showInfo={false} size="small" strokeColor={pct >= 80 ? '#16803c' : pct >= 50 ? '#b76b00' : '#c62828'} />
                  <span className={styles.scoreValue}>{scores[key]}/5</span>
                </>
              )}
            </div>
          );
        })}
      </div>
    );
  }

  renderFindings(findings = []) {
    if (!findings.length) {
      return <div className={styles.emptyState}>{t('ui.audit.noFindings')}</div>;
    }
    return (
      <div className={styles.findingList}>
        {findings.map((item) => (
          <div className={styles.finding} key={item.id}>
            <div className={styles.findingHeader}>
              <Tag color={severityColor(item.severity)}>{item.severity}</Tag>
              {item.hardGate && <Tag color="red">{t('ui.audit.hardGate')}</Tag>}
              <span className={styles.findingTitle}>{item.title}</span>
            </div>
            {item.recommendation && <div className={styles.recommendation}>{item.recommendation}</div>}
            {Array.isArray(item.evidence) && item.evidence.length > 0 && (
              <div className={styles.evidenceList}>
                {item.evidence.map((ev, idx) => (
                  <div className={styles.evidence} key={`${item.id}-${idx}`}>
                    <span className={styles.evidenceRef}>#{Number(ev.requestIndex) + 1}{ev.path ? ` · ${ev.path}` : ''}</span>
                    {ev.excerpt && <span className={styles.evidenceExcerpt}>{ev.excerpt}</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    );
  }

  render() {
    const { audit, loading, error } = this.state;
    const metadata = audit?.metadata;
    const report = audit?.report;
    const metrics = report?.metrics || audit?.evidenceBundle?.metrics || {};
    const meta = statusMeta(report?.overallStatus || 'needs-attention');

    return (
      <ConfigProvider theme={{ token: { colorPrimary: '#2457c5', borderRadius: 6 } }}>
        <div className={styles.page}>
          <header className={styles.header}>
            <div>
              <div className={styles.kicker}><DashboardOutlined /> {t('ui.audit.title')}</div>
              <h1>{metadata?.source?.sourceLabel || t('ui.audit.loadingTitle')}</h1>
              <div className={styles.subtle}>
                {metadata?.source?.sourceProvider || '-'} · {t('ui.audit.createdAt')} {formatDate(metadata?.createdAt)}
              </div>
            </div>
            <div className={styles.actions}>
              <Button href={pageUrl('/')}>{t('ui.audit.backToViewer')}</Button>
              <Button icon={<ReloadOutlined />} loading={this.state.rerunLoading} onClick={this.handleRerun} disabled={!metadata}>
                {t('ui.audit.rerun')}
              </Button>
            </div>
          </header>

          {loading && <div className={styles.center}><Spin /> <span>{t('ui.audit.loading')}</span></div>}
          {error && <Alert type="error" showIcon message={error} className={styles.alert} />}

          {!loading && !error && audit && (
            <>
              <section className={styles.summaryBand}>
                <div>
                  <Tag color={meta.color} icon={meta.icon} className={styles.statusTag}>{meta.label}</Tag>
                  <h2>{report?.summary?.title || t('ui.audit.summaryUnavailable')}</h2>
                  <p>{t('ui.audit.summaryText')}</p>
                </div>
                <div className={styles.metricsGrid}>
                  {this.renderMetric(t('ui.audit.metricRequests'), formatNumber(metrics.entryCount))}
                  {this.renderMetric(t('ui.audit.metricToolCalls'), formatNumber(metrics.toolCallCount))}
                  {this.renderMetric(t('ui.audit.metricFailedTools'), formatNumber(metrics.failedToolResultCount))}
                  {this.renderMetric(t('ui.audit.metricTokens'), formatNumber(metrics.totalTokens))}
                </div>
              </section>

              <main className={styles.grid}>
                <section className={styles.panel}>
                  <div className={styles.panelHeader}>
                    <h2>{t('ui.audit.ruleFindings')}</h2>
                    <span>{t('ui.audit.ruleFindingsDesc')}</span>
                  </div>
                  {this.renderFindings(report?.ruleFindings || audit.ruleFindings)}
                </section>

                <aside className={styles.side}>
                  <section className={styles.panel}>
                    <div className={styles.panelHeader}>
                      <h2>{t('ui.audit.categoryScores')}</h2>
                      <span>{t('ui.audit.categoryScoresDesc')}</span>
                    </div>
                    {this.renderScores(report)}
                  </section>

                  <section className={styles.panel}>
                    <div className={styles.panelHeader}>
                      <h2>{t('ui.audit.llmReview')}</h2>
                      <span>{t('ui.audit.llmReviewDesc')}</span>
                    </div>
                    <Alert
                      type={report?.reviewerOutput?.status === 'complete' ? 'success' : 'info'}
                      showIcon
                      message={report?.reviewerOutput?.status || 'not_configured'}
                      description={report?.reviewerOutput?.message || t('ui.audit.llmNotConfigured')}
                    />
                  </section>

                  <section className={styles.panel}>
                    <Collapse
                      bordered={false}
                      items={[{
                        key: 'diagnostics',
                        label: t('ui.audit.diagnostics'),
                        children: <pre className={styles.diagnostics}>{JSON.stringify({ metadata, stages: metadata?.stages }, null, 2)}</pre>,
                      }]}
                    />
                  </section>
                </aside>
              </main>
            </>
          )}
        </div>
      </ConfigProvider>
    );
  }
}
