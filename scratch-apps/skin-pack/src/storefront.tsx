import {
  accountLink,
  asset,
  BuyForm,
  CartCount,
  defineStorefront,
  editable,
  Gallery,
  Image,
  Island,
  menuDrawer,
  openCart,
  Price,
  quickAdd,
  Recommendations,
  raw,
  Reviews,
  searchOpener,
  stickyHeader,
  t,
  type HeaderProps,
  type ProductCardProps,
  type ProductMainProps,
  type SectionProps,
  type StorefrontImage,
  type StorefrontMenuItem,
  type StorefrontProductCard,
} from "@scalius/plugin-sdk/storefront";

// HACK: settings types are written twice, once in the manifest and once
// here; nothing infers SectionProps from the manifest (DX-REPORT DX-3).
interface HeaderSettings { sticky: boolean; promo_title: string; promo_link: string }

function MegaPanel({ item, id, settings, context }: { item: StorefrontMenuItem; id: string; settings: HeaderSettings; context: HeaderProps["context"] }) {
  return (
    <div class="atelier-mega" id={id} hidden>
      <div class="atelier-mega-cols">
        {item.children.map((column) => (
          <div class="atelier-mega-col">
            <a class="atelier-mega-head" href={column.url}>{column.title}</a>
            {column.children.length > 0 ? <ul>{column.children.map((link) => <li><a href={link.url}>{link.title}</a></li>)}</ul> : null}
          </div>
        ))}
      </div>
      {/* Menu items carry no image or description, so the promotion is the theme's own file. */}
      <a class="atelier-mega-promo" href={settings.promo_link}>
        <img src={asset(context, "public/promo.svg")} alt="" width="240" height="300" loading="lazy" />
        <span>{settings.promo_title}</span>
      </a>
    </div>
  );
}

function Header({ data, settings, context }: HeaderProps<HeaderSettings>) {
  return (
    <header class="atelier-header" {...(settings.sticky ? stickyHeader() : {})}>
      <div class="atelier-bar">
        <button type="button" class="atelier-menu-button" popovertarget="atelier-drawer" aria-label={t(context, { en: "Open menu", bn: "মেনু খুলুন" })}>☰</button>
        <a class="atelier-logo" href={data.routes.home}>
          {data.store.logo ? <Image image={data.store.logo} alt={data.store.name} loading="eager" /> : data.store.name}
        </a>
        <nav class="atelier-nav" aria-label={t(context, { en: "Main", bn: "প্রধান" })}>
          <ul data-nav-overflow>
            {data.menu.map((item, index) => {
              const panel = `atelier-mega-${index}`;
              const mega = item.children.length > 0;
              return (
                <li class="atelier-nav-item" data-nav-index={String(index)} data-disclosure-item={mega ? "" : undefined}>
                  <a href={item.url} data-nav-link>{item.title}</a>
                  {mega ? (
                    <button type="button" class="atelier-nav-toggle" data-disclosure="popup" aria-expanded="false" aria-controls={panel}>
                      <span class="atelier-sr">{t(context, { en: `${item.title} menu`, bn: `${item.title} মেনু` })}</span>▾
                    </button>
                  ) : null}
                  {mega ? <MegaPanel item={item} id={panel} settings={settings} context={context} /> : null}
                </li>
              );
            })}
          </ul>
        </nav>
        <div class="atelier-actions">
          <a href={data.routes.search} {...searchOpener()}>{t(context, { en: "Search", bn: "খুঁজুন" })}</a>
          <a href={data.routes.account} {...accountLink()}>{t(context, { en: "Account", bn: "অ্যাকাউন্ট" })}</a>
          {/* HACK: no app may draw in the cart drawer, so the upsell the brief asks for has nowhere to go. */}
          <a href={data.routes.cart} {...openCart()}>{t(context, { en: "Bag", bn: "ব্যাগ" })} <CartCount class="atelier-count" /></a>
        </div>
      </div>
      <div id="atelier-drawer" popover="auto" class="atelier-drawer" {...menuDrawer()}>
        <ul>{data.menu.map((item) => <li><a href={item.url}>{item.title}</a></li>)}</ul>
      </div>
    </header>
  );
}

function Card({ data, settings, context }: ProductCardProps<{ show_rating: boolean }>) {
  const { product, aboveFold, position } = data;
  return (
    <article class="atelier-card">
      <a href={product.url} class="atelier-card-media">
        <Image image={product.image} sizes="(min-width: 64rem) 25vw, 50vw" loading={aboveFold && position < 4 ? "eager" : "lazy"} />
        {product.hoverImage ? <Image image={product.hoverImage} class="atelier-card-hover" sizes="(min-width: 64rem) 25vw, 50vw" /> : null}
      </a>
      <h3><a href={product.url}>{product.title}</a></h3>
      <Price price={product.price} compareAt={product.compareAt} from={product.priceVaries} context={context} />
      {settings.show_rating && product.rating ? <p class="atelier-rating">★ {product.rating.average.toFixed(1)}</p> : null}
      {product.soldOut ? <p class="atelier-sold">{t(context, { en: "Sold out", bn: "স্টক শেষ" })}</p> : <a class="atelier-add" {...quickAdd(product)}>{t(context, { en: "Add", bn: "যোগ করুন" })}</a>}
    </article>
  );
}

function ProductMain({ data, settings }: ProductMainProps<{ gallery: string }>) {
  const { product } = data;
  return (
    <article class="atelier-pdp">
      {settings.gallery === "core" ? <div class="atelier-pdp-media"><Gallery /></div> : (
        // A gallery of our own: every photo stacked, the chosen SKU's photo
        // moved first by the island. HACK: the island learns the chosen
        // variant from the buy form's private markup (DX-REPORT CFG-3).
        <Island name="gallery" props={{ variants: product.variants.map((variant) => ({ id: variant.id, image: variant.image?.url ?? null })) }} hydrate="idle">
          <div class="atelier-pdp-media atelier-stack">
            {product.media.map((image: StorefrontImage, index: number) => (
              <Image image={image} sizes="(min-width: 64rem) 55vw, 100vw" loading={index === 0 ? "eager" : "lazy"} />
            ))}
          </div>
        </Island>
      )}
      <div class="atelier-pdp-buy" data-sticky-column style="top: calc(var(--header-height, 0px) + 1rem + var(--sticky-column-shift, 0px))">
        <h1>{product.title}</h1>
        <BuyForm title={false} />
        <div class="atelier-pdp-story">{raw(product.descriptionHtml)}</div>
      </div>
      <Reviews />
      <Recommendations />
    </article>
  );
}

interface LookbookSettings {
  heading: string;
  looks: Array<{ photo: StorefrontImage | null; title: string; text: string; link: string }>;
  products: StorefrontProductCard[];
}

function Lookbook({ settings, context }: SectionProps<LookbookSettings>) {
  if (settings.looks.length === 0) return null;
  return (
    <section class="atelier-lookbook">
      <h2 {...editable(context, "heading")}>{settings.heading}</h2>
      {settings.looks.map((look, index) => (
        <figure class="atelier-look">
          {look.photo ? <Image image={look.photo} sizes="100vw" loading={index === 0 ? "eager" : "lazy"} /> : null}
          <figcaption>
            <h3>{look.title}</h3>
            {look.text ? <p>{look.text}</p> : null}
            {look.link ? <a href={look.link}>{t(context, { en: "Explore", bn: "দেখুন" })}</a> : null}
          </figcaption>
        </figure>
      ))}
      {settings.products.length > 0 ? (
        <ul class="atelier-look-rail">
          {settings.products.map((product) => (
            <li><a href={product.url}><Image image={product.image} sizes="12rem" />{product.title}</a> <Price price={product.price} context={context} /></li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

export default defineStorefront({
  sections: { lookbook: Lookbook },
  skins: { "atelier-header": Header, "atelier-card": Card, "atelier-pdp": ProductMain },
});
