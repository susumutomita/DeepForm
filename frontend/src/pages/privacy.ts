import { t } from '../i18n';

export function renderPrivacyPolicy(): string {
  return `
<article class="policy-page">
  <p class="policy-meta" data-i18n="privacy.lastUpdated">${t('privacy.lastUpdated')}</p>
  <h1 data-i18n="privacy.title">${t('privacy.title')}</h1>
  <p data-i18n="privacy.intro">${t('privacy.intro')}</p>

  <h2 data-i18n="privacy.s1.title">${t('privacy.s1.title')}</h2>
  <p data-i18n="privacy.s1.desc">${t('privacy.s1.desc')}</p>
  <ul>
    <li data-i18n="privacy.s1.item1">${t('privacy.s1.item1')}</li>
    <li data-i18n="privacy.s1.item2">${t('privacy.s1.item2')}</li>
    <li data-i18n="privacy.s1.item3">${t('privacy.s1.item3')}</li>
  </ul>

  <h2 data-i18n="privacy.s2.title">${t('privacy.s2.title')}</h2>
  <p data-i18n="privacy.s2.desc">${t('privacy.s2.desc')}</p>
  <ul>
    <li data-i18n="privacy.s2.item1">${t('privacy.s2.item1')}</li>
    <li data-i18n="privacy.s2.item2">${t('privacy.s2.item2')}</li>
    <li data-i18n="privacy.s2.item3">${t('privacy.s2.item3')}</li>
    <li data-i18n="privacy.s2.item4">${t('privacy.s2.item4')}</li>
    <li data-i18n="privacy.s2.item5">${t('privacy.s2.item5')}</li>
  </ul>

  <h2 data-i18n="privacy.s3.title">${t('privacy.s3.title')}</h2>
  <p data-i18n="privacy.s3.desc1">${t('privacy.s3.desc1')}</p>
  <p data-i18n="privacy.s3.desc2">${t('privacy.s3.desc2')}</p>

  <h2 data-i18n="privacy.s4.title">${t('privacy.s4.title')}</h2>
  <p data-i18n="privacy.s4.desc">${t('privacy.s4.desc')}</p>

  <h2 data-i18n="privacy.s5.title">${t('privacy.s5.title')}</h2>
  <p data-i18n="privacy.s5.desc">${t('privacy.s5.desc')}</p>

  <h2 data-i18n="privacy.s6.title">${t('privacy.s6.title')}</h2>
  <p data-i18n="privacy.s6.desc">${t('privacy.s6.desc')}</p>

  <h2 data-i18n="privacy.s7.title">${t('privacy.s7.title')}</h2>
  <p data-i18n="privacy.s7.desc">${t('privacy.s7.desc')}</p>
  <ul>
    <li data-i18n="privacy.s7.item1">${t('privacy.s7.item1')}</li>
    <li data-i18n="privacy.s7.item2">${t('privacy.s7.item2')}</li>
    <li data-i18n="privacy.s7.item3">${t('privacy.s7.item3')}</li>
  </ul>

  <h2 data-i18n="privacy.s8.title">${t('privacy.s8.title')}</h2>
  <p data-i18n="privacy.s8.desc">${t('privacy.s8.desc')}</p>

  <h2 data-i18n="privacy.s9.title">${t('privacy.s9.title')}</h2>
  <p data-i18n="privacy.s9.desc">${t('privacy.s9.desc')}</p>
</article>
`;
}
