import React from 'react';

interface EmphasizedTextProps {
  /** A translated sentence with its placeholder still in it: `t(key)` without vars leaves `{email}` intact. */
  template: string;
  placeholder: string;
  value: string;
  className?: string;
  style?: React.CSSProperties;
}

/**
 * Renders one placeholder of a translated sentence as a highlighted span —
 * "Code an **anna@firma.de** gesendet" — while the word order stays whatever
 * the dictionary says for that language.
 */
const EmphasizedText: React.FC<EmphasizedTextProps> = ({ template, placeholder, value, className, style }) => {
  const token = `{${placeholder}}`;
  const at = template.indexOf(token);
  if (at === -1) return <>{template}</>;
  return (
    <>
      {template.slice(0, at)}
      <span className={className} style={style}>{value}</span>
      {template.slice(at + token.length)}
    </>
  );
};

export default EmphasizedText;
