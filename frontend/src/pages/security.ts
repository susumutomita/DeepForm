import { t } from '../i18n';

export function renderSecurityPolicy(): string {
  return `
<article class="policy-page">
  <p class="policy-meta" data-i18n="security.lastUpdated">${t('security.lastUpdated')}</p>
  <h1 data-i18n="security.title">${t('security.title')}</h1>
  <p data-i18n="security.intro">${t('security.intro')}</p>

  <h2 data-i18n="security.s1.title">${t('security.s1.title')}</h2>
  <p data-i18n="security.s1.desc1">${t('security.s1.desc1')}</p>
  <p><strong data-i18n="security.s1.desc2">${t('security.s1.desc2')}</strong></p>

  <h2 data-i18n="security.s2.title">${t('security.s2.title')}</h2>
  <p data-i18n="security.s2.desc">${t('security.s2.desc')}</p>

  <h2 data-i18n="security.s3.title">${t('security.s3.title')}</h2>
  <p data-i18n="security.s3.desc">${t('security.s3.desc')}</p>
  <ul>
    <li data-i18n="security.s3.item1">${t('security.s3.item1')}</li>
    <li data-i18n="security.s3.item2">${t('security.s3.item2')}</li>
    <li data-i18n="security.s3.item3">${t('security.s3.item3')}</li>
  </ul>

  <h2 data-i18n="security.s4.title">${t('security.s4.title')}</h2>
  <p data-i18n="security.s4.desc">${t('security.s4.desc')}</p>
  <ul>
    <li data-i18n="security.s4.item1">${t('security.s4.item1')}</li>
    <li data-i18n="security.s4.item2">${t('security.s4.item2')}</li>
    <li data-i18n="security.s4.item3">${t('security.s4.item3')}</li>
  </ul>

  <h2 data-i18n="security.s5.title">${t('security.s5.title')}</h2>
  <p data-i18n="security.s5.desc">${t('security.s5.desc')}</p>

  <h2 data-i18n="security.s6.title">${t('security.s6.title')}</h2>
  <p data-i18n="security.s6.desc">${t('security.s6.desc')}</p>

  <h2 data-i18n="security.s7.title">${t('security.s7.title')}</h2>
  <p data-i18n="security.s7.desc">${t('security.s7.desc')}</p>
  <ul>
    <li data-i18n="security.s7.item1">${t('security.s7.item1')}</li>
    <li data-i18n="security.s7.item2">${t('security.s7.item2')}</li>
    <li data-i18n="security.s7.item3">${t('security.s7.item3')}</li>
  </ul>

  <h2 data-i18n="security.s8.title">${t('security.s8.title')}</h2>
  <p data-i18n="security.s8.desc">${t('security.s8.desc')}</p>

  <h2 data-i18n="security.s9.title">${t('security.s9.title')}</h2>
  <p data-i18n="security.s9.desc">${t('security.s9.desc')}</p>

  <h2 data-i18n="security.s10.title">${t('security.s10.title')}</h2>
  <p data-i18n="security.s10.desc">${t('security.s10.desc')}</p>
</article>
`;
}
