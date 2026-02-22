import { t } from '../i18n';

export function renderTerms(): string {
  return `
<article class="policy-page">
  <p class="policy-meta" data-i18n="terms.lastUpdated">${t('terms.lastUpdated')}</p>
  <h1 data-i18n="terms.title">${t('terms.title')}</h1>
  <p data-i18n="terms.intro">${t('terms.intro')}</p>

  <h2 data-i18n="terms.s1.title">${t('terms.s1.title')}</h2>
  <p data-i18n="terms.s1.desc">${t('terms.s1.desc')}</p>

  <h2 data-i18n="terms.s2.title">${t('terms.s2.title')}</h2>
  <p data-i18n="terms.s2.desc">${t('terms.s2.desc')}</p>

  <h2 data-i18n="terms.s3.title">${t('terms.s3.title')}</h2>
  <p data-i18n="terms.s3.desc">${t('terms.s3.desc')}</p>
  <ul>
    <li data-i18n="terms.s3.item1">${t('terms.s3.item1')}</li>
    <li data-i18n="terms.s3.item2">${t('terms.s3.item2')}</li>
    <li data-i18n="terms.s3.item3">${t('terms.s3.item3')}</li>
    <li data-i18n="terms.s3.item4">${t('terms.s3.item4')}</li>
  </ul>

  <h2 data-i18n="terms.s4.title">${t('terms.s4.title')}</h2>
  <p><strong data-i18n="terms.s4.desc1">${t('terms.s4.desc1')}</strong></p>
  <p data-i18n="terms.s4.desc2">${t('terms.s4.desc2')}</p>

  <h2 data-i18n="terms.s5.title">${t('terms.s5.title')}</h2>
  <p data-i18n="terms.s5.desc">${t('terms.s5.desc')}</p>
  <ul>
    <li data-i18n="terms.s5.item1">${t('terms.s5.item1')}</li>
    <li data-i18n="terms.s5.item2">${t('terms.s5.item2')}</li>
    <li data-i18n="terms.s5.item3">${t('terms.s5.item3')}</li>
    <li data-i18n="terms.s5.item4">${t('terms.s5.item4')}</li>
  </ul>

  <h2 data-i18n="terms.s6.title">${t('terms.s6.title')}</h2>
  <p data-i18n="terms.s6.desc">${t('terms.s6.desc')}</p>

  <h2 data-i18n="terms.s7.title">${t('terms.s7.title')}</h2>
  <p data-i18n="terms.s7.desc">${t('terms.s7.desc')}</p>

  <h2 data-i18n="terms.s8.title">${t('terms.s8.title')}</h2>
  <p data-i18n="terms.s8.desc">${t('terms.s8.desc')}</p>
  <ul>
    <li data-i18n="terms.s8.item1">${t('terms.s8.item1')}</li>
    <li data-i18n="terms.s8.item2">${t('terms.s8.item2')}</li>
    <li data-i18n="terms.s8.item3">${t('terms.s8.item3')}</li>
    <li data-i18n="terms.s8.item4">${t('terms.s8.item4')}</li>
    <li data-i18n="terms.s8.item5">${t('terms.s8.item5')}</li>
    <li data-i18n="terms.s8.item6">${t('terms.s8.item6')}</li>
  </ul>

  <h2 data-i18n="terms.s9.title">${t('terms.s9.title')}</h2>
  <p data-i18n="terms.s9.desc">${t('terms.s9.desc')}</p>

  <h2 data-i18n="terms.s10.title">${t('terms.s10.title')}</h2>
  <p data-i18n="terms.s10.desc">${t('terms.s10.desc')}</p>

  <h2 data-i18n="terms.s11.title">${t('terms.s11.title')}</h2>
  <p data-i18n="terms.s11.desc">${t('terms.s11.desc')}</p>

  <h2 data-i18n="terms.s12.title">${t('terms.s12.title')}</h2>
  <p data-i18n="terms.s12.desc">${t('terms.s12.desc')}</p>

  <h2 data-i18n="terms.s13.title">${t('terms.s13.title')}</h2>
  <p data-i18n="terms.s13.desc">${t('terms.s13.desc')}</p>
</article>
`;
}
